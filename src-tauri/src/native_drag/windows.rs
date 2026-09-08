//! Native OS drag-and-drop for remote files, Windows implementation.
//!
//! `tauri-plugin-drag`, the off-the-shelf option tried first, only supports
//! dragging files that already exist on disk, which meant downloading the
//! remote file to a temp path *before* calling its `start_drag` — but
//! Windows' `DoDragDrop` must be entered while the mouse button is still
//! physically held, and any async work first (like a network download)
//! almost always loses that race, making the drag silently do nothing.
//!
//! This implements a proper virtual/lazy-file drag instead, the same
//! mechanism Outlook uses for attachments: `DoDragDrop` starts immediately
//! (no download beforehand), and the actual remote download only happens
//! later, on demand, when Explorer's copy engine calls back into our
//! `IDataObject` asking for `CFSTR_FILECONTENTS` — see
//! `VirtualDataObject::GetData`.
//!
//! Two threading rules shape everything below, both learned the hard way
//! (each earlier variant froze the app and/or Explorer for the whole
//! download, or broke the drag outright):
//!
//! 1. `DoDragDrop` must run on the main thread — the one tracking the live
//!    mouse gesture. Run anywhere else, the drag ends instantly with nothing
//!    delivered.
//! 2. Nothing the drop target calls back into may block the main thread.
//!    Explorer copies a virtual file *synchronously inside `IDropTarget::Drop`*
//!    unless the data object implements `IDataObjectAsyncCapability`, which
//!    parks Explorer's own UI thread (the spinning cursor on the Desktop /
//!    the frozen target folder) and, since `DoDragDrop` is waiting on that
//!    very `Drop` call, parks our main thread too. And even with the copy
//!    made asynchronous, a COM object created on the main (STA) thread has
//!    every `Read` marshaled back onto that thread, so a slow download would
//!    still stall the UI one chunk at a time.
//!
//! So: the data object advertises `IDataObjectAsyncCapability` (Explorer
//! then returns from `Drop` at once and pulls the bytes on a background
//! thread of its own, after `DoDragDrop` has returned), and the object is
//! created in a multi-threaded apartment on a dedicated keeper thread and
//! only *marshaled* to the main thread for `DoDragDrop` — so every
//! `GetData`/`Read` Explorer makes lands on a COM worker thread where it can
//! block for as long as the download takes, while the main thread never
//! sees any of it.
use crate::ipc::{CommandError, ErrorCode};
use crate::native_drag::DragOutFile;
use crate::transfer::error_kind::transfer_error_kind;
use crate::transfer::progress::{ProgressEmitter, TransferProgressPayload};
use crate::transfer::transfer_pool::{TaskFn, TransferPool};
use serde::Serialize;
use std::mem::ManuallyDrop;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex as StdMutex, Once, OnceLock, mpsc};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, DuplexStream};
use tokio::sync::oneshot;
use windows::{
    Win32::{
        Foundation::*,
        Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL},
        System::Com::{
            Marshal::CoMarshalInterThreadInterfaceInStream,
            StructuredStorage::CoGetInterfaceAndReleaseStream, *,
        },
        System::DataExchange::RegisterClipboardFormatW,
        System::Memory::{GMEM_FIXED, GlobalAlloc, GlobalLock, GlobalUnlock},
        System::Ole::{
            DROPEFFECT, DROPEFFECT_COPY, DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize,
        },
        System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS},
        UI::Shell::{
            CFSTR_FILECONTENTS, CFSTR_FILEDESCRIPTORW, FD_ATTRIBUTES, FD_FILESIZE, FD_UNICODE,
            FILEDESCRIPTORW, IDataObjectAsyncCapability, IDataObjectAsyncCapability_Impl,
            SHCreateStdEnumFmtEtc,
        },
    },
    core::*,
};

const CHUNK_BUF: usize = 64 * 1024;

/// `HRESULT_FROM_WIN32(ERROR_CANCELLED)`. This crate version has no
/// `HRESULT::from_win32`, and the SDK macro is just a bit pattern: the
/// failure bit, facility 7 (Win32), and the Win32 code in the low word.
/// Derived from the constant rather than hard-coded so it can't drift.
const HRESULT_CANCELLED: HRESULT = HRESULT((0x8007_0000u32 | (ERROR_CANCELLED.0 & 0xFFFF)) as i32);

static OLE_INIT: Once = Once::new();
static mut OLE_RESULT: windows::core::Result<()> = Ok(());

/// `OleInitialize` is per-thread (STA) and must run on the same thread that
/// later calls `DoDragDrop` — i.e. inside `run_on_main_thread`, never here.
fn init_ole() -> windows::core::Result<()> {
    unsafe {
        OLE_INIT.call_once(|| {
            OLE_RESULT = OleInitialize(None);
        });
        #[allow(static_mut_refs)]
        let result = OLE_RESULT.clone();
        result
    }
}

fn utf16_name(name: &str) -> [u16; 260] {
    let mut buf = [0u16; 260];
    let encoded: Vec<u16> = name.encode_utf16().take(259).collect();
    buf[..encoded.len()].copy_from_slice(&encoded);
    buf
}

/// Builds the `CFSTR_FILEDESCRIPTORW` payload: a `FILEGROUPDESCRIPTORW`
/// (`cItems` + a packed `FILEDESCRIPTORW[]`) in a `GMEM_FIXED` block, the
/// same construction style `tauri-plugin-drag`'s vendored `drag` crate used
/// for its `DROPFILES` HGLOBAL.
fn build_descriptor_hglobal(files: &[DragOutFile]) -> windows::core::Result<HGLOBAL> {
    let entry_size = std::mem::size_of::<FILEDESCRIPTORW>();
    let total = 4 + files.len() * entry_size;
    unsafe {
        let handle = GlobalAlloc(GMEM_FIXED, total)?;
        let base = GlobalLock(handle) as *mut u8;
        std::ptr::write_unaligned(base as *mut u32, files.len() as u32);
        for (i, file) in files.iter().enumerate() {
            let mut descriptor: FILEDESCRIPTORW = std::mem::zeroed();
            descriptor.dwFlags = (FD_UNICODE.0 | FD_ATTRIBUTES.0) as u32;
            descriptor.dwFileAttributes = if file.is_directory {
                FILE_ATTRIBUTE_DIRECTORY.0
            } else {
                FILE_ATTRIBUTE_NORMAL.0
            };
            descriptor.cFileName = utf16_name(&file.name);
            if let Some(size) = file.size.filter(|_| !file.is_directory) {
                descriptor.dwFlags |= FD_FILESIZE.0 as u32;
                descriptor.nFileSizeHigh = (size >> 32) as u32;
                descriptor.nFileSizeLow = (size & 0xFFFF_FFFF) as u32;
            }
            let entry_ptr = base.add(4 + i * entry_size) as *mut FILEDESCRIPTORW;
            std::ptr::write_unaligned(entry_ptr, descriptor);
        }
        GlobalUnlock(handle)?;
        Ok(handle)
    }
}

#[implement(IDropSource)]
struct DropSource;

#[allow(non_snake_case)]
impl IDropSource_Impl for DropSource_Impl {
    fn QueryContinueDrag(&self, fescapepressed: BOOL, grfkeystate: MODIFIERKEYS_FLAGS) -> HRESULT {
        if fescapepressed.as_bool() {
            DRAGDROP_S_CANCEL
        } else if !grfkeystate.contains(MK_LBUTTON) {
            DRAGDROP_S_DROP
        } else {
            S_OK
        }
    }

    fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

/// Emitted once per file the moment a drop target starts pulling its bytes
/// (i.e. the drop actually happened and this file's download began) so the
/// Transfers panel can add a row for it — the frontend only tracks rows it
/// knows about, and unlike every other transfer, it isn't the frontend that
/// starts this one. Subsequent updates ride the ordinary `transfer:progress`
/// event under the same id.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DragOutStartedPayload {
    is_directory: bool,
    id: String,
    connection_id: String,
    protocol: String,
    name: String,
    remote_file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
}

/// Everything a drag-out download needs to show up in the Transfers panel
/// like any other transfer.
#[derive(Clone)]
pub(crate) struct TransferReporter {
    app: AppHandle,
    progress: ProgressEmitter,
    connection_id: String,
    protocol: String,
}

impl TransferReporter {
    pub(crate) fn new(
        app: AppHandle,
        progress: ProgressEmitter,
        connection_id: String,
        protocol: String,
    ) -> Self {
        Self {
            app,
            progress,
            connection_id,
            protocol,
        }
    }

    fn started(&self, id: &str, file: &DragOutFile) {
        let _ = self.app.emit(
            "transfer:dragOutStarted",
            DragOutStartedPayload {
                is_directory: file.is_directory,
                id: id.to_string(),
                connection_id: self.connection_id.clone(),
                protocol: self.protocol.clone(),
                name: file
                    .name
                    .rsplit('\\')
                    .next()
                    .unwrap_or(&file.name)
                    .to_string(),
                remote_file: file.remote_path.clone(),
                total: file.size,
            },
        );
    }

    fn progress(&self, id: &str, bytes: u64, total: Option<u64>) {
        self.progress.send(TransferProgressPayload {
            id: id.to_string(),
            connection_id: self.connection_id.clone(),
            status: "progress",
            bytes: Some(bytes),
            total,
            error: None,
            error_code: None,
        });
    }

    fn done(&self, id: &str, bytes: u64, total: Option<u64>) {
        self.progress.send(TransferProgressPayload {
            id: id.to_string(),
            connection_id: self.connection_id.clone(),
            status: "done",
            bytes: Some(bytes),
            total,
            error: None,
            error_code: None,
        });
    }

    fn error(&self, id: &str, failure: CommandError) {
        self.progress.send(TransferProgressPayload {
            id: id.to_string(),
            connection_id: self.connection_id.clone(),
            status: "error",
            bytes: None,
            total: None,
            error_code: Some(transfer_error_kind(failure.code)),
            // The raw text when we have it (it names the server reply), the
            // safe sentence otherwise; the renderer localizes the code anyway.
            error: Some(failure.details.unwrap_or(failure.message)),
        });
    }
}

/// Wraps the reader half of an in-memory duplex pipe that a background task
/// (spawned from `VirtualDataObject::GetData`) is filling from the remote
/// server via `ProtocolBackend::download_to_writer`.
#[implement(IStream)]
struct VirtualFileStream {
    reader: StdMutex<DuplexStream>,
    /// Resolved by the download task once `pool.run` has settled — consulted
    /// at EOF so a failed download surfaces as a read error (Explorer then
    /// shows its own "can't copy" dialog) rather than a silently short file.
    outcome: StdMutex<Option<oneshot::Receiver<std::result::Result<(), CommandError>>>>,
    size: Option<u64>,
    position: AtomicU64,
    /// Set once a terminal status (done/error) has been reported, so `Drop`
    /// knows whether Explorer released us mid-transfer (user cancelled the
    /// copy) or after finishing.
    finished: AtomicBool,
    task_id: String,
    pool: TransferPool,
    reporter: TransferReporter,
}

impl VirtualFileStream {
    fn finish_ok(&self, bytes: u64) {
        if !self.finished.swap(true, Ordering::SeqCst) {
            self.reporter.done(&self.task_id, bytes, self.size);
        }
    }

    fn finish_err(&self, failure: CommandError) {
        if !self.finished.swap(true, Ordering::SeqCst) {
            self.reporter.error(&self.task_id, failure);
        }
    }
}

impl Drop for VirtualFileStream {
    /// Explorer releasing the stream is the only signal we get that the user
    /// cancelled its copy dialog mid-transfer. It can also release without a
    /// final zero-byte `Read` once it has pulled exactly the size we
    /// announced, which is a normal completion, not a cancel.
    fn drop(&mut self) {
        if self.finished.load(Ordering::SeqCst) {
            return;
        }
        let position = self.position.load(Ordering::SeqCst);
        if self.size.is_some_and(|size| position >= size) {
            self.finish_ok(position);
        } else {
            self.pool.cancel(&self.task_id);
            self.finish_err(CommandError::new(ErrorCode::Cancelled, "Canceled by user"));
        }
    }
}

#[allow(non_snake_case)]
impl ISequentialStream_Impl for VirtualFileStream_Impl {
    /// A blocking COM call from Explorer's copy engine. It arrives on a COM
    /// worker thread (the object lives in the MTA — see the module docs), so
    /// blocking here for as long as the remote server takes to produce the
    /// next chunk is fine: nothing the user can see waits on this thread.
    fn Read(&self, pv: *mut core::ffi::c_void, cb: u32, pcbread: *mut u32) -> HRESULT {
        if pv.is_null() {
            return E_INVALIDARG;
        }
        // A panic can't unwind through the `extern "system"` vtable shim
        // this is called from: it aborts the whole app (seen live). Turn it
        // into a plain read failure Explorer can report instead.
        let guarded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.read_chunk(pv, cb, pcbread)
        }));
        match guarded {
            Ok(hresult) => hresult,
            Err(_) => {
                self.finish_err(CommandError::new(
                    ErrorCode::Internal,
                    "Internal error while reading the file",
                ));
                E_FAIL
            }
        }
    }

    fn Write(&self, _pv: *const core::ffi::c_void, _cb: u32, _pcbwritten: *mut u32) -> HRESULT {
        STG_E_ACCESSDENIED
    }
}

impl VirtualFileStream_Impl {
    fn read_chunk(&self, pv: *mut core::ffi::c_void, cb: u32, pcbread: *mut u32) -> HRESULT {
        let buf = unsafe { std::slice::from_raw_parts_mut(pv as *mut u8, cb as usize) };
        let result = {
            let mut reader = self.reader.lock().unwrap();
            tauri::async_runtime::block_on(reader.read(buf))
        };
        match result {
            Ok(n) => {
                let position = self.position.fetch_add(n as u64, Ordering::SeqCst) + n as u64;
                if !pcbread.is_null() {
                    unsafe { *pcbread = n as u32 };
                }
                if n == 0 {
                    // The writer half is only dropped once the download task
                    // has settled, so this wait is short and never stalls on
                    // the network.
                    let outcome = self.outcome.lock().unwrap().take();
                    let settled = outcome
                        .map(|rx| tauri::async_runtime::block_on(rx))
                        .unwrap_or(Ok(Ok(())));
                    return match settled {
                        Ok(Ok(())) => {
                            self.finish_ok(position);
                            S_FALSE
                        }
                        Ok(Err(failure)) => {
                            // Disconnecting mid-drag (or hitting Stop) is not
                            // a failure to report as one: STG_E_READFAULT made
                            // Explorer announce "a disk error occurred during a
                            // read operation", which points the user at their
                            // hardware for something they just did on purpose.
                            let cancelled = failure.code == ErrorCode::Cancelled;
                            self.finish_err(failure);
                            if cancelled {
                                HRESULT_CANCELLED
                            } else {
                                STG_E_READFAULT
                            }
                        }
                        Err(_) => {
                            self.finish_err(CommandError::new(
                                ErrorCode::Internal,
                                "Transfer ended unexpectedly",
                            ));
                            STG_E_READFAULT
                        }
                    };
                }
                self.reporter.progress(&self.task_id, position, self.size);
                if (n as u32) < cb { S_FALSE } else { S_OK }
            }
            Err(err) => {
                self.finish_err(CommandError::from(err));
                E_FAIL
            }
        }
    }
}

#[allow(non_snake_case)]
impl IStream_Impl for VirtualFileStream_Impl {
    fn Seek(
        &self,
        dlibmove: i64,
        dworigin: STREAM_SEEK,
        plibnewposition: *mut u64,
    ) -> windows::core::Result<()> {
        // Virtual-file streams are explicitly allowed to be forward-only
        // (MSDN); only answer the trivial "what's the current position"
        // probe some copy engines make defensively.
        if dworigin == STREAM_SEEK_CUR && dlibmove == 0 {
            if !plibnewposition.is_null() {
                unsafe { *plibnewposition = self.position.load(Ordering::SeqCst) };
            }
            Ok(())
        } else {
            Err(Error::from_hresult(STG_E_INVALIDFUNCTION))
        }
    }

    fn SetSize(&self, _libnewsize: u64) -> windows::core::Result<()> {
        Err(Error::from_hresult(STG_E_INVALIDFUNCTION))
    }

    fn CopyTo(
        &self,
        _pstm: windows::core::Ref<'_, IStream>,
        _cb: u64,
        _pcbread: *mut u64,
        _pcbwritten: *mut u64,
    ) -> windows::core::Result<()> {
        Err(Error::from_hresult(STG_E_INVALIDFUNCTION))
    }

    fn Commit(&self, _grfcommitflags: &STGC) -> windows::core::Result<()> {
        Ok(())
    }

    fn Revert(&self) -> windows::core::Result<()> {
        Ok(())
    }

    fn LockRegion(
        &self,
        _liboffset: u64,
        _cb: u64,
        _dwlocktype: &LOCKTYPE,
    ) -> windows::core::Result<()> {
        Err(Error::from_hresult(STG_E_INVALIDFUNCTION))
    }

    fn UnlockRegion(
        &self,
        _liboffset: u64,
        _cb: u64,
        _dwlocktype: u32,
    ) -> windows::core::Result<()> {
        Err(Error::from_hresult(STG_E_INVALIDFUNCTION))
    }

    fn Stat(&self, pstatstg: *mut STATSTG, _grfstatflag: &STATFLAG) -> windows::core::Result<()> {
        unsafe {
            *pstatstg = std::mem::zeroed();
            (*pstatstg).r#type = STGTY_STREAM.0 as u32;
            (*pstatstg).cbSize = self.size.unwrap_or(0);
        }
        Ok(())
    }

    fn Clone(&self) -> windows::core::Result<IStream> {
        Err(Error::from_hresult(E_NOTIMPL))
    }
}

/// The drag payload: announces the file list via `CFSTR_FILEDESCRIPTORW`
/// and, lazily, streams each file's bytes via `CFSTR_FILECONTENTS` — the
/// actual remote download only starts once a drop target asks for a given
/// file's contents (`GetData` with that format), never before.
///
/// Lives in the MTA (see module docs); everything in here must therefore be
/// safe to touch from any COM worker thread.
#[implement(IDataObject, IDataObjectAsyncCapability)]
struct VirtualDataObject {
    files: Vec<DragOutFile>,
    folder_transfers: OnceLock<Vec<String>>,
    folders_finished: AtomicBool,
    manifest: OnceLock<std::result::Result<Vec<DragOutFile>, String>>,
    pool: TransferPool,
    cf_descriptor: u16,
    cf_contents: u16,
    reporter: TransferReporter,
    async_mode: AtomicBool,
    in_operation: AtomicBool,
    /// Dropped with the object; the keeper thread's `recv` on the other end
    /// is how it learns every reference (ours and Explorer's) is gone and
    /// the apartment can be torn down.
    _keepalive: mpsc::Sender<()>,
}

impl VirtualDataObject {
    fn start_folders(&self) {
        self.folder_transfers.get_or_init(|| {
            self.files
                .iter()
                .filter(|file| file.is_directory)
                .map(|file| {
                    let id = uuid::Uuid::new_v4().to_string();
                    self.reporter.started(&id, file);
                    id
                })
                .collect()
        });
    }

    fn finish_folders(&self, result: HRESULT) {
        if self.folders_finished.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(folders) = self.folder_transfers.get() {
            for id in folders {
                if result.is_ok() {
                    // Child file rows own byte accounting; this row tracks the folder operation.
                    self.reporter.done(id, 0, None);
                } else {
                    self.reporter.error(
                        id,
                        CommandError::new(
                            if result == HRESULT_CANCELLED || result == E_ABORT {
                                ErrorCode::Cancelled
                            } else {
                                ErrorCode::Internal
                            },
                            "Explorer folder copy did not complete",
                        ),
                    );
                }
            }
        }
    }

    fn expanded_files(&self) -> windows::core::Result<&[DragOutFile]> {
        match self.manifest.get_or_init(|| {
            tauri::async_runtime::block_on(super::manifest::expand(&self.pool, self.files.clone()))
                .map_err(|error| error.to_string())
        }) {
            Ok(files) => Ok(files),
            Err(message) => Err(Error::new(E_FAIL, message.as_str())),
        }
    }

    fn contents_index(&self, fmt: &FORMATETC) -> Option<usize> {
        if fmt.cfFormat != self.cf_contents || fmt.lindex < 0 {
            return None;
        }
        let index = fmt.lindex as usize;
        self.expanded_files()
            .ok()?
            .get(index)
            .filter(|file| !file.is_directory)
            .map(|_| index)
    }

    /// Shell drop targets probe `CFSTR_FILECONTENTS` with `lindex == -1`
    /// ("do you support this format at all?") before ever asking for a
    /// specific file's contents with a real index — distinct from
    /// `contents_index`, which is only for an actual retrievable item.
    fn offers_contents(&self, fmt: &FORMATETC) -> bool {
        fmt.cfFormat == self.cf_contents && !self.files.is_empty()
    }

    fn open_stream(&self, file: &DragOutFile) -> IStream {
        let (writer, reader) = tokio::io::duplex(CHUNK_BUF);
        let (outcome_tx, outcome_rx) = oneshot::channel();
        let pool = self.pool.clone();
        let remote_path = file.remote_path.clone();
        let task_id = uuid::Uuid::new_v4().to_string();
        self.reporter.started(&task_id, file);
        let run_id = task_id.clone();
        tauri::async_runtime::spawn(async move {
            let mut writer = writer;
            let task: TaskFn = Box::new(move |backend| {
                Box::pin(async move { backend.download_to_writer(&remote_path, &mut writer).await })
            });
            // `writer` (owned by `task`) is gone by the time this resolves,
            // so the reader's EOF always precedes — never races — this send.
            let result = pool
                .run(run_id, task)
                .await
                .map_err(|err| CommandError::from_anyhow(&err));
            let _ = outcome_tx.send(result);
        });
        VirtualFileStream {
            reader: StdMutex::new(reader),
            outcome: StdMutex::new(Some(outcome_rx)),
            size: file.size,
            position: AtomicU64::new(0),
            finished: AtomicBool::new(false),
            task_id,
            pool: self.pool.clone(),
            reporter: self.reporter.clone(),
        }
        .into()
    }
}

impl Drop for VirtualDataObject {
    fn drop(&mut self) {
        // A target can release the object without completing its operation.
        self.finish_folders(HRESULT_CANCELLED);
    }
}

#[allow(non_snake_case)]
impl IDataObject_Impl for VirtualDataObject_Impl {
    fn GetData(&self, pformatetc: *const FORMATETC) -> windows::core::Result<STGMEDIUM> {
        let fmt = unsafe { &*pformatetc };
        if fmt.cfFormat == self.cf_descriptor {
            let handle = build_descriptor_hglobal(self.expanded_files()?)?;
            return Ok(STGMEDIUM {
                tymed: TYMED_HGLOBAL.0 as u32,
                u: STGMEDIUM_0 { hGlobal: handle },
                pUnkForRelease: ManuallyDrop::new(None),
            });
        }
        if let Some(index) = self.contents_index(fmt) {
            let stream = self.open_stream(&self.expanded_files()?[index]);
            return Ok(STGMEDIUM {
                tymed: TYMED_ISTREAM.0 as u32,
                u: STGMEDIUM_0 {
                    pstm: ManuallyDrop::new(Some(stream)),
                },
                pUnkForRelease: ManuallyDrop::new(None),
            });
        }
        Err(Error::from_hresult(DV_E_FORMATETC))
    }

    fn GetDataHere(
        &self,
        _pformatetc: *const FORMATETC,
        _pmedium: *mut STGMEDIUM,
    ) -> windows::core::Result<()> {
        Err(Error::from_hresult(DV_E_FORMATETC))
    }

    fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
        let fmt = unsafe { &*pformatetc };
        if fmt.cfFormat == self.cf_descriptor || self.offers_contents(fmt) {
            S_OK
        } else {
            DV_E_FORMATETC
        }
    }

    fn GetCanonicalFormatEtc(
        &self,
        _pformatectin: *const FORMATETC,
        pformatetcout: *mut FORMATETC,
    ) -> HRESULT {
        if !pformatetcout.is_null() {
            unsafe { (*pformatetcout).ptd = std::ptr::null_mut() };
        }
        E_NOTIMPL
    }

    fn SetData(
        &self,
        _pformatetc: *const FORMATETC,
        _pmedium: *const STGMEDIUM,
        _frelease: BOOL,
    ) -> windows::core::Result<()> {
        Err(Error::from_hresult(E_NOTIMPL))
    }

    fn EnumFormatEtc(&self, dwdirection: u32) -> windows::core::Result<IEnumFORMATETC> {
        // Explorer's shell drop target (and the drag-image helper) calls this
        // during DragEnter to discover whether we're offering a virtual-file
        // group descriptor *before* it will accept the drop at all — without
        // it, every drop target outside our own process rejects the drag
        // (permanent "no" cursor), even though QueryGetData/GetData alone
        // work fine for a target that already knows what to ask for.
        if dwdirection != DATADIR_GET.0 as u32 {
            return Err(Error::from_hresult(E_NOTIMPL));
        }
        let formats = [
            FORMATETC {
                cfFormat: self.cf_descriptor,
                ptd: std::ptr::null_mut(),
                dwAspect: DVASPECT_CONTENT.0,
                lindex: -1,
                tymed: TYMED_HGLOBAL.0 as u32,
            },
            FORMATETC {
                cfFormat: self.cf_contents,
                ptd: std::ptr::null_mut(),
                dwAspect: DVASPECT_CONTENT.0,
                lindex: -1,
                tymed: TYMED_ISTREAM.0 as u32,
            },
        ];
        unsafe { SHCreateStdEnumFmtEtc(&formats) }
    }

    fn DAdvise(
        &self,
        _pformatetc: *const FORMATETC,
        _advf: u32,
        _padvsink: windows::core::Ref<'_, IAdviseSink>,
    ) -> windows::core::Result<u32> {
        Err(Error::from_hresult(OLE_E_ADVISENOTSUPPORTED))
    }

    fn DUnadvise(&self, _dwconnection: u32) -> windows::core::Result<()> {
        Err(Error::from_hresult(OLE_E_ADVISENOTSUPPORTED))
    }

    fn EnumDAdvise(&self) -> windows::core::Result<IEnumSTATDATA> {
        Err(Error::from_hresult(OLE_E_ADVISENOTSUPPORTED))
    }
}

/// Lets Explorer (the drop target) finish `IDropTarget::Drop` immediately
/// and perform the actual copy — all the `GetData`/`Read` traffic — on a
/// background thread of its own afterwards. Without this it copies
/// synchronously inside `Drop`, freezing its own window *and* ours (our
/// main thread is inside `DoDragDrop`, waiting for that `Drop` to return)
/// for the entire download.
#[allow(non_snake_case)]
impl IDataObjectAsyncCapability_Impl for VirtualDataObject_Impl {
    fn SetAsyncMode(&self, fdoopasync: BOOL) -> windows::core::Result<()> {
        self.async_mode
            .store(fdoopasync.as_bool(), Ordering::SeqCst);
        Ok(())
    }

    fn GetAsyncMode(&self) -> windows::core::Result<BOOL> {
        Ok(self.async_mode.load(Ordering::SeqCst).into())
    }

    fn StartOperation(
        &self,
        _pbcreserved: windows::core::Ref<'_, IBindCtx>,
    ) -> windows::core::Result<()> {
        self.start_folders();
        self.in_operation.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn InOperation(&self) -> windows::core::Result<BOOL> {
        Ok(self.in_operation.load(Ordering::SeqCst).into())
    }

    fn EndOperation(
        &self,
        hresult: HRESULT,
        _pbcreserved: windows::core::Ref<'_, IBindCtx>,
        _dweffects: u32,
    ) -> windows::core::Result<()> {
        self.finish_folders(hresult);
        self.in_operation.store(false, Ordering::SeqCst);
        log::debug!("drag-out: drop target finished its async copy with {hresult}");
        Ok(())
    }
}

/// A COM interface pointer being handed between threads. Only ever wraps
/// the marshaling stream from `CoMarshalInterThreadInterfaceInStream`,
/// which is documented as safe to pass to another thread.
struct RawInterface(*mut core::ffi::c_void);
unsafe impl Send for RawInterface {}

/// Runs the native drag-and-drop session for `files`, resolving once the
/// user drops or cancels. With `IDataObjectAsyncCapability` in play that is
/// *before* the download itself, which continues in the background under
/// Explorer's control and is reported to the Transfers panel by `reporter`.
///
/// The data object is built and marshaled on its own MTA keeper thread, then
/// unmarshaled on the main thread purely so `DoDragDrop` can be called there
/// (the only thread it works from — see module docs). The keeper thread stays
/// alive, keeping the apartment (and so Explorer's proxies) valid, until the
/// object's last reference is gone.
pub async fn start_drag(
    window: tauri::Window,
    reporter: TransferReporter,
    pool: TransferPool,
    files: Vec<DragOutFile>,
) -> anyhow::Result<()> {
    let (marshal_tx, marshal_rx) = mpsc::channel::<anyhow::Result<RawInterface>>();
    let (keep_tx, keep_rx) = mpsc::channel::<()>();
    std::thread::Builder::new()
        .name("ftpeach-drag-out".into())
        .spawn(move || {
            let init = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if init.is_err() {
                let _ = marshal_tx.send(Err(anyhow::anyhow!("CoInitializeEx failed: {init}")));
                return;
            }
            let marshaled = (|| -> anyhow::Result<RawInterface> {
                let cf_descriptor =
                    unsafe { RegisterClipboardFormatW(CFSTR_FILEDESCRIPTORW) } as u16;
                let cf_contents = unsafe { RegisterClipboardFormatW(CFSTR_FILECONTENTS) } as u16;
                let data_object: IDataObject = VirtualDataObject {
                    files,
                    folder_transfers: OnceLock::new(),
                    folders_finished: AtomicBool::new(false),
                    manifest: OnceLock::new(),
                    pool,
                    cf_descriptor,
                    cf_contents,
                    reporter,
                    async_mode: AtomicBool::new(true),
                    in_operation: AtomicBool::new(false),
                    _keepalive: keep_tx,
                }
                .into();
                let stream = unsafe {
                    CoMarshalInterThreadInterfaceInStream(&IDataObject::IID, &data_object)
                }
                .map_err(|e| anyhow::anyhow!("Marshaling the drag data object failed: {e}"))?;
                Ok(RawInterface(stream.into_raw()))
            })();
            let failed = marshaled.is_err();
            let _ = marshal_tx.send(marshaled);
            if !failed {
                // Returns only once the data object (holding the sender) has
                // been dropped, i.e. after Explorer's async copy released it.
                let _ = keep_rx.recv();
            }
            unsafe { CoUninitialize() };
        })?;

    let (tx, rx) = oneshot::channel();
    window.run_on_main_thread(move || {
        let result = (|| -> anyhow::Result<()> {
            init_ole().map_err(|e| anyhow::anyhow!("OleInitialize failed: {e}"))?;
            let RawInterface(raw) = marshal_rx
                .recv()
                .map_err(|_| anyhow::anyhow!("Drag keeper thread exited before marshaling"))??;
            let stream = unsafe { IStream::from_raw(raw) };
            let data_object: IDataObject = unsafe { CoGetInterfaceAndReleaseStream(&stream) }
                .map_err(|e| anyhow::anyhow!("Unmarshaling the drag data object failed: {e}"))?;
            // `CoGetInterfaceAndReleaseStream` has already released the
            // stream, so it must not be released a second time on drop.
            std::mem::forget(stream);
            let drop_source: IDropSource = DropSource.into();
            let mut out_effect = DROPEFFECT::default();
            unsafe { DoDragDrop(&data_object, &drop_source, DROPEFFECT_COPY, &mut out_effect) }
                .ok()
                .map_err(|e| anyhow::anyhow!("DoDragDrop failed: {e}"))
        })();
        let _ = tx.send(result);
    })?;
    rx.await
        .map_err(|_| anyhow::anyhow!("Main thread channel closed before the drag finished"))?
}

#[cfg(test)]
mod descriptor_tests {
    use super::*;

    #[test]
    fn folders_and_nested_files_have_correct_descriptors() {
        let files = vec![
            DragOutFile {
                remote_path: "/folder".into(),
                name: "folder".into(),
                size: Some(999),
                is_directory: true,
            },
            DragOutFile {
                remote_path: "/folder/empty".into(),
                name: "folder\\empty".into(),
                size: None,
                is_directory: true,
            },
            DragOutFile {
                remote_path: "/folder/file.txt".into(),
                name: "folder\\file.txt".into(),
                size: Some(42),
                is_directory: false,
            },
        ];
        let handle = build_descriptor_hglobal(&files).unwrap();
        unsafe {
            let base = GlobalLock(handle) as *const u8;
            assert_eq!(std::ptr::read_unaligned(base as *const u32), 3);
            for (index, file) in files.iter().enumerate() {
                let descriptor = std::ptr::read_unaligned(
                    base.add(4 + index * std::mem::size_of::<FILEDESCRIPTORW>())
                        as *const FILEDESCRIPTORW,
                );
                assert_ne!(descriptor.dwFlags & FD_ATTRIBUTES.0 as u32, 0);
                assert_eq!(
                    descriptor.dwFileAttributes == FILE_ATTRIBUTE_DIRECTORY.0,
                    file.is_directory
                );
                assert_eq!(
                    descriptor.dwFlags & FD_FILESIZE.0 as u32 != 0,
                    !file.is_directory
                );
                let name = descriptor.cFileName;
                assert_eq!(name, utf16_name(&file.name));
                if !file.is_directory {
                    let size = descriptor.nFileSizeLow;
                    assert_eq!(size, 42);
                }
            }
            GlobalUnlock(handle).unwrap();
            // GlobalFree returns NULL on success, which windows 0.61 maps to Err.
            let _ = GlobalFree(Some(handle));
        }
    }
}
