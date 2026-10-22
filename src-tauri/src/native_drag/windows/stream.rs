//! The stream Explorer reads a dragged-out remote file from, filled by its
//! download as Explorer asks for it.
use super::*;

/// Wraps the reader half of an in-memory duplex pipe that a background task
/// (spawned from `VirtualDataObject::GetData`) is filling from the remote
/// server via `ProtocolBackend::download_to_writer`.
#[implement(IStream)]
pub(super) struct VirtualFileStream {
    pub(super) reader: StdMutex<DuplexStream>,
    /// Resolved by the download task once `pool.run` has settled — consulted
    /// at EOF so a failed download surfaces as a read error (Explorer then
    /// shows its own "can't copy" dialog) rather than a silently short file.
    pub(super) outcome: StdMutex<Option<oneshot::Receiver<std::result::Result<(), CommandError>>>>,
    pub(super) size: Option<u64>,
    pub(super) position: AtomicU64,
    /// Set once a terminal status (done/error) has been reported, so `Drop`
    /// knows whether Explorer released us mid-transfer (user cancelled the
    /// copy) or after finishing.
    pub(super) finished: AtomicBool,
    pub(super) task_id: String,
    pub(super) pool: TransferPool,
    pub(super) reporter: TransferReporter,
    /// The row of the folder this file was dragged out inside, which reports
    /// for it; `None` for a file dragged out on its own, with a row of its own.
    pub(super) folder: Option<Arc<FolderRow>>,
}

impl VirtualFileStream {
    pub(super) fn finish_ok(&self, bytes: u64) {
        if !self.finished.swap(true, Ordering::SeqCst) {
            match &self.folder {
                Some(folder) => folder.file_done(),
                None => self.reporter.done(&self.task_id, bytes, self.size),
            }
        }
    }

    pub(super) fn finish_err(&self, failure: CommandError) {
        if !self.finished.swap(true, Ordering::SeqCst) {
            match &self.folder {
                Some(folder) => folder.fail(failure),
                None => self.reporter.error(&self.task_id, failure),
            }
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
    pub(super) fn read_chunk(
        &self,
        pv: *mut core::ffi::c_void,
        cb: u32,
        pcbread: *mut u32,
    ) -> HRESULT {
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
                match &self.folder {
                    Some(folder) => {
                        self.reporter
                            .progress(&folder.id, folder.add(n as u64), Some(folder.total))
                    }
                    None => self.reporter.progress(&self.task_id, position, self.size),
                }
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
