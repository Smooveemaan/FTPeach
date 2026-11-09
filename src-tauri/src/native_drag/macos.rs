//! Native OS drag-and-drop for remote files, macOS implementation.
//!
//! Dragging remote files out to Finder uses `NSFilePromiseProvider` (`NSPasteboardWriting`).
//! The drag gesture begins immediately (`beginDraggingSessionWithItems:event:source:`)
//! without downloading in advance, so holding the mouse button does not race against network downloads.
//! Unlike Windows (which streams bytes into a virtual COM object), macOS Finder promises files to
//! the destination folder: the download runs after the user releases the mouse (drop), inside
//! `NSFilePromiseProviderDelegate::filePromiseProvider:writePromiseToURL:completionHandler:`.
//!
//! Once dropped into Finder, each item appears in the Transfers panel as an active transfer
//! with real-time progress, applies macOS download quarantine (`com.apple.quarantine`), and signals
//! success or cancellation back to Finder via the promise completion handler.

use super::DragOutFile;
use super::report::TransferReporter;
use crate::transfer::transfer_pool::TransferPool;
use std::sync::Arc;
use tauri::Window;

/// Resolves the Apple Uniform Type Identifier (UTI) for a file name or directory.
#[allow(dead_code)]
pub fn uti_for_file(name: &str, is_directory: bool) -> &'static str {
    if is_directory {
        return "public.folder";
    }
    let ext = name
        .rsplit('.')
        .next()
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "txt" | "log" | "md" | "markdown" => "public.plain-text",
        "html" | "htm" => "public.html",
        "json" => "public.json",
        "xml" => "public.xml",
        "png" => "public.png",
        "jpg" | "jpeg" => "public.jpeg",
        "gif" => "com.compuserve.gif",
        "svg" => "public.svg-image",
        "pdf" => "com.adobe.pdf",
        "zip" => "public.zip-archive",
        "tar" => "public.tar-archive",
        "gz" => "org.gnu.gnu-zip-archive",
        "mp3" => "public.mp3",
        "mp4" => "public.mpeg-4",
        "mov" => "com.apple.quicktime-movie",
        "dmg" => "com.apple.disk-image-udif",
        _ => "public.data",
    }
}

/// Extracts a clean file or directory basename safe for POSIX filesystems.
#[allow(dead_code)]
pub fn clean_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name).trim();
    if base.is_empty() || base == "." || base == ".." {
        "download".to_string()
    } else {
        base.replace('/', "_").replace('\0', "")
    }
}

#[cfg(target_os = "macos")]
mod macos_impl {
    use super::*;
    use crate::ipc::{CommandError, ErrorCode};
    use crate::transfer::progress::ProgressInfo;
    use crate::transfer::transfer_pool::TaskFn;
    use anyhow::{Context, Result, bail};
    use std::ffi::{CStr, CString, c_char, c_void};
    use std::path::PathBuf;
    use std::sync::{Mutex, Once};
    use tokio::sync::oneshot;

    const OBJC_ASSOCIATION_ASSIGN: usize = 0;
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x08000100;
    const K_CFURL_POSIX_PATH_STYLE: isize = 0;

    #[link(name = "AppKit", kind = "framework")]
    #[link(name = "CoreFoundation", kind = "framework")]
    #[link(name = "objc", kind = "dylib")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> *const c_void;
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn objc_msgSend();
        fn objc_allocateClassPair(
            superclass: *const c_void,
            name: *const c_char,
            extra_bytes: usize,
        ) -> *mut c_void;
        fn objc_registerClassPair(cls: *mut c_void);
        fn class_addMethod(
            cls: *mut c_void,
            name: *const c_void,
            imp: *const (),
            types: *const c_char,
        ) -> u8;
        fn objc_setAssociatedObject(
            object: *const c_void,
            key: *const c_void,
            value: *const c_void,
            policy: usize,
        );
        fn objc_getAssociatedObject(object: *const c_void, key: *const c_void) -> *const c_void;

        fn CFRelease(cf: *const c_void);
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const c_char,
            encoding: u32,
        ) -> *const c_void;
        #[allow(dead_code)]
        fn CFURLCreateWithFileSystemPath(
            allocator: *const c_void,
            file_path: *const c_void,
            path_style: isize,
            is_directory: u8,
        ) -> *const c_void;
        fn CFURLCopyFileSystemPath(an_url: *const c_void, path_style: isize) -> *const c_void;
        fn CFStringGetLength(the_string: *const c_void) -> isize;
        fn CFStringGetCString(
            the_string: *const c_void,
            buffer: *mut c_char,
            buffer_size: isize,
            encoding: u32,
        ) -> u8;

        fn _Block_copy(block: *const c_void) -> *const c_void;
        fn _Block_release(block: *const c_void);
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSPoint {
        x: f64,
        y: f64,
    }

    #[repr(C)]
    struct BlockLiteral {
        _isa: *const c_void,
        _flags: i32,
        _reserved: i32,
        invoke: unsafe extern "C" fn(*const c_void, *const c_void),
        _descriptor: *const c_void,
    }

    struct CfRef(*const c_void);
    impl Drop for CfRef {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) };
            }
        }
    }

    fn cf_string(s: &str) -> Option<CfRef> {
        let c_str = CString::new(s).ok()?;
        let ptr = unsafe {
            CFStringCreateWithCString(std::ptr::null(), c_str.as_ptr(), K_CF_STRING_ENCODING_UTF8)
        };
        if ptr.is_null() {
            None
        } else {
            Some(CfRef(ptr))
        }
    }

    fn cf_url_to_path(cf_url: *const c_void) -> Option<PathBuf> {
        if cf_url.is_null() {
            return None;
        }
        let path_cf = unsafe { CFURLCopyFileSystemPath(cf_url, K_CFURL_POSIX_PATH_STYLE) };
        if path_cf.is_null() {
            return None;
        }
        let _guard = CfRef(path_cf);
        unsafe {
            let len = CFStringGetLength(path_cf);
            let max_bytes = (len * 4 + 1) as usize;
            let mut buf = vec![0u8; max_bytes];
            let ok = CFStringGetCString(
                path_cf,
                buf.as_mut_ptr() as *mut _,
                max_bytes as isize,
                K_CF_STRING_ENCODING_UTF8,
            );
            if ok != 0 {
                CStr::from_ptr(buf.as_ptr() as *const _)
                    .to_str()
                    .ok()
                    .map(PathBuf::from)
            } else {
                None
            }
        }
    }

    unsafe fn invoke_completion_handler(handler: *const c_void, error: *const c_void) {
        if !handler.is_null() {
            unsafe {
                let block = &*(handler as *const BlockLiteral);
                (block.invoke)(handler, error);
            }
        }
    }

    unsafe fn create_ns_error(description: &str) -> *const c_void {
        let cls_nserror = unsafe { objc_getClass(c"NSError".as_ptr()) };
        if cls_nserror.is_null() {
            return std::ptr::null();
        }
        let domain = cf_string("com.smooveemaan.ftpeach");
        let msg_send_error: unsafe extern "C" fn(
            *const c_void,
            *const c_void,
            *const c_void,
            isize,
            *const c_void,
        ) -> *const c_void = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        let sel_error = unsafe { sel_registerName(c"errorWithDomain:code:userInfo:".as_ptr()) };
        let _ = description;
        unsafe {
            msg_send_error(
                cls_nserror,
                sel_error,
                domain.map_or(std::ptr::null(), |d| d.0),
                1,
                std::ptr::null(),
            )
        }
    }

    static DRAG_SOURCE_KEY: u8 = 0;
    static PROMISE_CONTEXT_KEY: u8 = 0;
    static REGISTER_CLASSES: Once = Once::new();

    struct DragSourceContext {
        sender: Mutex<Option<oneshot::Sender<Result<()>>>>,
    }

    struct PromiseContext {
        file: DragOutFile,
        reporter: TransferReporter,
        pool: TransferPool,
        origin_base: String,
    }

    extern "C" fn drag_source_mask(
        _this: *const c_void,
        _sel: *const c_void,
        _session: *const c_void,
        _context: isize,
    ) -> usize {
        1 // NSDragOperationCopy
    }

    extern "C" fn drag_source_ended(
        this: *const c_void,
        _sel: *const c_void,
        _session: *const c_void,
        _ended_at: NSPoint,
        _operation: usize,
    ) {
        unsafe {
            let ptr = objc_getAssociatedObject(this, &DRAG_SOURCE_KEY as *const _ as *const c_void);
            if !ptr.is_null() {
                let ctx = &*(ptr as *const DragSourceContext);
                if let Some(sender) = ctx.sender.lock().unwrap().take() {
                    let _ = sender.send(Ok(()));
                }
            }
        }
    }

    extern "C" fn promise_file_name(
        this: *const c_void,
        _sel: *const c_void,
        _provider: *const c_void,
        _file_type: *const c_void,
    ) -> *const c_void {
        unsafe {
            let ptr =
                objc_getAssociatedObject(this, &PROMISE_CONTEXT_KEY as *const _ as *const c_void);
            if ptr.is_null() {
                return std::ptr::null();
            }
            let ctx = &*(ptr as *const PromiseContext);
            let name = clean_file_name(&ctx.file.name);
            let cf = cf_string(&name);
            cf.map_or(std::ptr::null(), |s| {
                let p = s.0;
                std::mem::forget(s);
                p
            })
        }
    }

    extern "C" fn promise_write(
        this: *const c_void,
        _sel: *const c_void,
        _provider: *const c_void,
        url: *const c_void,
        completion_handler: *const c_void,
    ) {
        let ptr = unsafe {
            objc_getAssociatedObject(this, &PROMISE_CONTEXT_KEY as *const _ as *const c_void)
        };
        if ptr.is_null() || completion_handler.is_null() {
            if !completion_handler.is_null() {
                unsafe {
                    let err = create_ns_error("Internal error in drag-out context");
                    invoke_completion_handler(completion_handler, err);
                }
            }
            return;
        }
        let ctx_arc: Arc<PromiseContext> = unsafe {
            let raw = ptr as *const PromiseContext;
            Arc::increment_strong_count(raw);
            Arc::from_raw(raw)
        };
        let dest_path = match cf_url_to_path(url) {
            Some(p) => p,
            None => {
                unsafe {
                    let err = create_ns_error("Invalid destination URL from Finder");
                    invoke_completion_handler(completion_handler, err);
                }
                return;
            }
        };
        let retained_handler = unsafe { _Block_copy(completion_handler) as usize };

        tauri::async_runtime::spawn(async move {
            let outcome = perform_promise_download(ctx_arc, dest_path).await;
            let handler = retained_handler as *const c_void;
            unsafe {
                match outcome {
                    Ok(()) => {
                        invoke_completion_handler(handler, std::ptr::null());
                    }
                    Err(err) => {
                        let ns_err = create_ns_error(&err.to_string());
                        invoke_completion_handler(handler, ns_err);
                    }
                }
                _Block_release(handler);
            }
        });
    }

    async fn perform_promise_download(ctx: Arc<PromiseContext>, dest_path: PathBuf) -> Result<()> {
        let transfer_id = uuid::Uuid::new_v4().to_string();
        ctx.reporter.started(&transfer_id, &ctx.file, ctx.file.size);
        ctx.reporter.status(&transfer_id, "progress");

        if ctx.file.is_directory {
            download_directory(ctx.clone(), transfer_id.clone(), dest_path).await
        } else {
            download_single_file(ctx.clone(), transfer_id.clone(), dest_path).await
        }
    }

    async fn download_single_file(
        ctx: Arc<PromiseContext>,
        transfer_id: String,
        dest_path: PathBuf,
    ) -> Result<()> {
        if let Some(parent) = dest_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let total = ctx.file.size;
        let reporter = ctx.reporter.clone();
        let id_for_progress = transfer_id.clone();
        let sink = Arc::new(move |info: ProgressInfo| {
            if let ProgressInfo::Progress { bytes, total } = info {
                reporter.progress(&id_for_progress, bytes, Some(total));
            }
        });

        let remote_path = ctx.file.remote_path.clone();
        let target = dest_path.clone();
        let task: TaskFn = Box::new(move |backend| {
            Box::pin(async move { backend.download(&remote_path, &target, false, sink).await })
        });

        match ctx.pool.run(transfer_id.clone(), task).await {
            Ok(()) => {
                let origin = crate::local_fs::provenance::Origin::for_url(
                    &ctx.origin_base,
                    &ctx.file.remote_path,
                );
                crate::local_fs::provenance::mark(&dest_path, &origin);
                let final_bytes = tokio::fs::metadata(&dest_path)
                    .await
                    .map(|m| m.len())
                    .unwrap_or_else(|_| total.unwrap_or(0));
                ctx.reporter.done(&transfer_id, final_bytes, total);
                Ok(())
            }
            Err(err) => {
                let cmd_err = CommandError::new(ErrorCode::Cancelled, err.to_string());
                ctx.reporter.error(&transfer_id, cmd_err);
                Err(err)
            }
        }
    }

    async fn download_directory(
        ctx: Arc<PromiseContext>,
        transfer_id: String,
        dest_dir: PathBuf,
    ) -> Result<()> {
        tokio::fs::create_dir_all(&dest_dir).await?;
        let reporter = ctx.reporter.clone();
        let id_for_progress = transfer_id.clone();
        let remote_dir = ctx.file.remote_path.clone();
        let local_dir = dest_dir.clone();
        let origin_base = ctx.origin_base.clone();

        let task: TaskFn = Box::new(move |backend| {
            Box::pin(async move {
                let mut transferred: u64 = 0;
                let mut queue = vec![(remote_dir, local_dir)];
                while let Some((rem, loc)) = queue.pop() {
                    tokio::fs::create_dir_all(&loc).await?;
                    let items = backend.list(&rem).await?;
                    for item in items {
                        if item.name == "." || item.name == ".." {
                            continue;
                        }
                        let child_rem = format!("{}/{}", rem.trim_end_matches('/'), item.name);
                        let child_loc = loc.join(&item.name);
                        if item.is_directory {
                            queue.push((child_rem, child_loc));
                        } else {
                            let item_size = item.size;
                            let rep = reporter.clone();
                            let t_id = id_for_progress.clone();
                            let current_base = transferred;
                            let sink = Arc::new(move |info: ProgressInfo| {
                                if let ProgressInfo::Progress { bytes, .. } = info {
                                    rep.progress(&t_id, current_base + bytes, None);
                                }
                            });
                            backend
                                .download(&child_rem, &child_loc, false, sink)
                                .await?;
                            let origin = crate::local_fs::provenance::Origin::for_url(
                                &origin_base,
                                &child_rem,
                            );
                            crate::local_fs::provenance::mark(&child_loc, &origin);
                            transferred += item_size;
                            reporter.progress(&id_for_progress, transferred, None);
                        }
                    }
                }
                Ok(())
            })
        });

        match ctx.pool.run(transfer_id.clone(), task).await {
            Ok(()) => {
                ctx.reporter.done(&transfer_id, 0, None);
                Ok(())
            }
            Err(err) => {
                let cmd_err = CommandError::new(ErrorCode::Cancelled, err.to_string());
                ctx.reporter.error(&transfer_id, cmd_err);
                Err(err)
            }
        }
    }

    fn ensure_classes_registered() {
        REGISTER_CLASSES.call_once(|| {
            unsafe {
                let super_cls = objc_getClass(c"NSObject".as_ptr());
                if super_cls.is_null() {
                    return;
                }

                // Register FTPeachDragSource
                let source_name = c"FTPeachDragSource";
                let drag_source_cls = objc_allocateClassPair(super_cls, source_name.as_ptr(), 0);
                if !drag_source_cls.is_null() {
                    let sel_mask = sel_registerName(
                        c"draggingSession:sourceOperationMaskForDraggingContext:".as_ptr(),
                    );
                    class_addMethod(
                        drag_source_cls,
                        sel_mask as *const _,
                        drag_source_mask as *const (),
                        c"Q@:@q".as_ptr(),
                    );

                    let sel_ended =
                        sel_registerName(c"draggingSession:endedAtPoint:operation:".as_ptr());
                    class_addMethod(
                        drag_source_cls,
                        sel_ended as *const _,
                        drag_source_ended as *const (),
                        c"v@:@{CGPoint=dd}Q".as_ptr(),
                    );

                    objc_registerClassPair(drag_source_cls);
                }

                // Register FTPeachFilePromiseDelegate
                let delegate_name = c"FTPeachFilePromiseDelegate";
                let delegate_cls = objc_allocateClassPair(super_cls, delegate_name.as_ptr(), 0);
                if !delegate_cls.is_null() {
                    let sel_file_name =
                        sel_registerName(c"filePromiseProvider:fileNameForType:".as_ptr());
                    class_addMethod(
                        delegate_cls,
                        sel_file_name as *const _,
                        promise_file_name as *const (),
                        c"@@:@@".as_ptr(),
                    );

                    let sel_write = sel_registerName(
                        c"filePromiseProvider:writePromiseToURL:completionHandler:".as_ptr(),
                    );
                    class_addMethod(
                        delegate_cls,
                        sel_write as *const _,
                        promise_write as *const (),
                        c"v@:@@@?".as_ptr(),
                    );

                    objc_registerClassPair(delegate_cls);
                }
            }
        });
    }

    pub async fn start_drag(
        window: Window,
        reporter: TransferReporter,
        pool: TransferPool,
        files: Vec<DragOutFile>,
        origin_base: String,
    ) -> Result<()> {
        ensure_classes_registered();
        let (tx, rx) = oneshot::channel();
        let context = Arc::new(DragSourceContext {
            sender: Mutex::new(Some(tx)),
        });

        let files_for_drag = files;
        let reporter_for_drag = reporter;
        let pool_for_drag = pool;
        let origin_for_drag = origin_base;
        let context_for_drag = context.clone();

        window.run_on_main_thread(move || {
            let res = (|| -> Result<()> {
                unsafe {
                    let cls_source = objc_getClass(c"FTPeachDragSource".as_ptr());
                    let cls_delegate = objc_getClass(c"FTPeachFilePromiseDelegate".as_ptr());
                    let cls_provider = objc_getClass(c"NSFilePromiseProvider".as_ptr());
                    let cls_item = objc_getClass(c"NSDraggingItem".as_ptr());
                    let cls_array = objc_getClass(c"NSMutableArray".as_ptr());
                    let cls_app = objc_getClass(c"NSApplication".as_ptr());

                    if cls_source.is_null()
                        || cls_delegate.is_null()
                        || cls_provider.is_null()
                        || cls_item.is_null()
                        || cls_array.is_null()
                        || cls_app.is_null()
                    {
                        bail!("Failed to look up AppKit drag classes");
                    }

                    let msg_send_alloc: unsafe extern "C" fn(
                        *const c_void,
                        *const c_void,
                    ) -> *const c_void = std::mem::transmute(objc_msgSend as *const ());
                    let msg_send_init: unsafe extern "C" fn(
                        *const c_void,
                        *const c_void,
                    ) -> *const c_void = std::mem::transmute(objc_msgSend as *const ());
                    let sel_alloc = sel_registerName(c"alloc".as_ptr());
                    let sel_init = sel_registerName(c"init".as_ptr());

                    // Instantiate FTPeachDragSource
                    let source = msg_send_alloc(cls_source, sel_alloc);
                    let source = msg_send_init(source, sel_init);
                    objc_setAssociatedObject(
                        source,
                        &DRAG_SOURCE_KEY as *const _ as *const c_void,
                        Arc::as_ptr(&context_for_drag) as *const c_void,
                        OBJC_ASSOCIATION_ASSIGN,
                    );

                    // Build dragging items array
                    let sel_array = sel_registerName(c"array".as_ptr());
                    let items_array = msg_send_alloc(cls_array, sel_array);
                    let sel_add_object = sel_registerName(c"addObject:".as_ptr());
                    let msg_send_add: unsafe extern "C" fn(
                        *const c_void,
                        *const c_void,
                        *const c_void,
                    ) = std::mem::transmute(objc_msgSend as *const ());

                    let sel_init_provider =
                        sel_registerName(c"initWithFileType:delegate:".as_ptr());
                    let msg_send_init_provider: unsafe extern "C" fn(
                        *const c_void,
                        *const c_void,
                        *const c_void,
                        *const c_void,
                    )
                        -> *const c_void = std::mem::transmute(objc_msgSend as *const ());

                    let sel_init_item = sel_registerName(c"initWithPasteboardWriter:".as_ptr());
                    let msg_send_init_item: unsafe extern "C" fn(
                        *const c_void,
                        *const c_void,
                        *const c_void,
                    )
                        -> *const c_void = std::mem::transmute(objc_msgSend as *const ());

                    for file in files_for_drag {
                        let promise_ctx = Arc::new(PromiseContext {
                            file: file.clone(),
                            reporter: reporter_for_drag.clone(),
                            pool: pool_for_drag.clone(),
                            origin_base: origin_for_drag.clone(),
                        });

                        let delegate = msg_send_alloc(cls_delegate, sel_alloc);
                        let delegate = msg_send_init(delegate, sel_init);
                        objc_setAssociatedObject(
                            delegate,
                            &PROMISE_CONTEXT_KEY as *const _ as *const c_void,
                            Arc::into_raw(promise_ctx) as *const c_void,
                            OBJC_ASSOCIATION_ASSIGN,
                        );

                        let uti = uti_for_file(&file.name, file.is_directory);
                        let uti_cf = cf_string(uti).context("failed to allocate UTI string")?;

                        let provider = msg_send_alloc(cls_provider, sel_alloc);
                        let provider =
                            msg_send_init_provider(provider, sel_init_provider, uti_cf.0, delegate);

                        let item = msg_send_alloc(cls_item, sel_alloc);
                        let item = msg_send_init_item(item, sel_init_item, provider);
                        msg_send_add(items_array, sel_add_object, item);
                    }

                    // Get NSView and current NSEvent
                    let sel_shared_app = sel_registerName(c"sharedApplication".as_ptr());
                    let app = msg_send_alloc(cls_app, sel_shared_app);
                    let sel_current_event = sel_registerName(c"currentEvent".as_ptr());
                    let msg_send_event: unsafe extern "C" fn(
                        *const c_void,
                        *const c_void,
                    ) -> *const c_void = std::mem::transmute(objc_msgSend as *const ());
                    let current_event = msg_send_event(app, sel_current_event);

                    let sel_key_window = sel_registerName(c"keyWindow".as_ptr());
                    let key_window = msg_send_event(app, sel_key_window);
                    if key_window.is_null() {
                        bail!("No key window available for drag session");
                    }

                    let sel_content_view = sel_registerName(c"contentView".as_ptr());
                    let view = msg_send_event(key_window, sel_content_view);
                    if view.is_null() {
                        bail!("No contentView available for drag session");
                    }

                    let sel_begin_drag =
                        sel_registerName(c"beginDraggingSessionWithItems:event:source:".as_ptr());
                    let msg_send_begin_drag: unsafe extern "C" fn(
                        *const c_void,
                        *const c_void,
                        *const c_void,
                        *const c_void,
                        *const c_void,
                    )
                        -> *const c_void = std::mem::transmute(objc_msgSend as *const ());

                    let session = msg_send_begin_drag(
                        view,
                        sel_begin_drag,
                        items_array,
                        current_event,
                        source,
                    );
                    if session.is_null() {
                        bail!("beginDraggingSessionWithItems failed to start");
                    }
                    Ok(())
                }
            })();

            if let (Err(e), Some(sender)) = (res, context_for_drag.sender.lock().unwrap().take()) {
                let _ = sender.send(Err(e));
            }
        })?;

        rx.await
            .map_err(|_| anyhow::anyhow!("Drag session channel closed"))?
    }

    pub async fn start_local_drag(window: Window, paths: Vec<String>) -> Result<()> {
        ensure_classes_registered();
        let (tx, rx) = oneshot::channel();
        let context = Arc::new(DragSourceContext {
            sender: Mutex::new(Some(tx)),
        });

        let context_for_drag = context.clone();
        window.run_on_main_thread(move || {
            let res = (|| -> Result<()> {
                unsafe {
                    let cls_source = objc_getClass(c"FTPeachDragSource".as_ptr());
                    let cls_item = objc_getClass(c"NSDraggingItem".as_ptr());
                    let cls_array = objc_getClass(c"NSMutableArray".as_ptr());
                    let cls_url = objc_getClass(c"NSURL".as_ptr());
                    let cls_app = objc_getClass(c"NSApplication".as_ptr());

                    if cls_source.is_null()
                        || cls_item.is_null()
                        || cls_array.is_null()
                        || cls_url.is_null()
                        || cls_app.is_null()
                    {
                        bail!("Failed to look up AppKit classes for local drag");
                    }

                    let msg_send_alloc: unsafe extern "C" fn(
                        *const c_void,
                        *const c_void,
                    ) -> *const c_void = std::mem::transmute(objc_msgSend as *const ());
                    let msg_send_init: unsafe extern "C" fn(
                        *const c_void,
                        *const c_void,
                    ) -> *const c_void = std::mem::transmute(objc_msgSend as *const ());
                    let sel_alloc = sel_registerName(c"alloc".as_ptr());
                    let sel_init = sel_registerName(c"init".as_ptr());

                    let source = msg_send_alloc(cls_source, sel_alloc);
                    let source = msg_send_init(source, sel_init);
                    objc_setAssociatedObject(
                        source,
                        &DRAG_SOURCE_KEY as *const _ as *const c_void,
                        Arc::as_ptr(&context_for_drag) as *const c_void,
                        OBJC_ASSOCIATION_ASSIGN,
                    );

                    let sel_array = sel_registerName(c"array".as_ptr());
                    let items_array = msg_send_alloc(cls_array, sel_array);
                    let sel_add_object = sel_registerName(c"addObject:".as_ptr());
                    let msg_send_add: unsafe extern "C" fn(
                        *const c_void,
                        *const c_void,
                        *const c_void,
                    ) = std::mem::transmute(objc_msgSend as *const ());

                    let sel_file_url = sel_registerName(c"fileURLWithPath:".as_ptr());
                    let msg_send_file_url: unsafe extern "C" fn(
                        *const c_void,
                        *const c_void,
                        *const c_void,
                    )
                        -> *const c_void = std::mem::transmute(objc_msgSend as *const ());

                    let sel_init_item = sel_registerName(c"initWithPasteboardWriter:".as_ptr());
                    let msg_send_init_item: unsafe extern "C" fn(
                        *const c_void,
                        *const c_void,
                        *const c_void,
                    )
                        -> *const c_void = std::mem::transmute(objc_msgSend as *const ());

                    for path in paths {
                        let path_cf = cf_string(&path).context("failed to allocate path string")?;
                        let ns_url = msg_send_file_url(cls_url, sel_file_url, path_cf.0);
                        if ns_url.is_null() {
                            continue;
                        }
                        let item = msg_send_alloc(cls_item, sel_alloc);
                        let item = msg_send_init_item(item, sel_init_item, ns_url);
                        msg_send_add(items_array, sel_add_object, item);
                    }

                    let sel_shared_app = sel_registerName(c"sharedApplication".as_ptr());
                    let app = msg_send_alloc(cls_app, sel_shared_app);
                    let sel_current_event = sel_registerName(c"currentEvent".as_ptr());
                    let msg_send_event: unsafe extern "C" fn(
                        *const c_void,
                        *const c_void,
                    ) -> *const c_void = std::mem::transmute(objc_msgSend as *const ());
                    let current_event = msg_send_event(app, sel_current_event);

                    let sel_key_window = sel_registerName(c"keyWindow".as_ptr());
                    let key_window = msg_send_event(app, sel_key_window);
                    if key_window.is_null() {
                        bail!("No key window available for local drag session");
                    }

                    let sel_content_view = sel_registerName(c"contentView".as_ptr());
                    let view = msg_send_event(key_window, sel_content_view);
                    if view.is_null() {
                        bail!("No contentView available for local drag session");
                    }

                    let sel_begin_drag =
                        sel_registerName(c"beginDraggingSessionWithItems:event:source:".as_ptr());
                    let msg_send_begin_drag: unsafe extern "C" fn(
                        *const c_void,
                        *const c_void,
                        *const c_void,
                        *const c_void,
                        *const c_void,
                    )
                        -> *const c_void = std::mem::transmute(objc_msgSend as *const ());

                    let session = msg_send_begin_drag(
                        view,
                        sel_begin_drag,
                        items_array,
                        current_event,
                        source,
                    );
                    if session.is_null() {
                        bail!("beginDraggingSessionWithItems failed for local drag");
                    }
                    Ok(())
                }
            })();

            if let (Err(e), Some(sender)) = (res, context_for_drag.sender.lock().unwrap().take()) {
                let _ = sender.send(Err(e));
            }
        })?;

        rx.await
            .map_err(|_| anyhow::anyhow!("Local drag session channel closed"))?
    }
}

#[cfg(target_os = "macos")]
pub use macos_impl::*;

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
pub async fn start_drag(
    _window: Window,
    _reporter: TransferReporter,
    _pool: TransferPool,
    _files: Vec<DragOutFile>,
    _origin_base: String,
) -> anyhow::Result<()> {
    anyhow::bail!("macOS native drag is not supported on this platform")
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
pub async fn start_local_drag(_window: Window, _paths: Vec<String>) -> anyhow::Result<()> {
    anyhow::bail!("macOS native drag is not supported on this platform")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_file_extensions_to_expected_macos_utis() {
        assert_eq!(uti_for_file("document.txt", false), "public.plain-text");
        assert_eq!(uti_for_file("notes.MD", false), "public.plain-text");
        assert_eq!(uti_for_file("index.html", false), "public.html");
        assert_eq!(uti_for_file("data.json", false), "public.json");
        assert_eq!(uti_for_file("feed.xml", false), "public.xml");
        assert_eq!(uti_for_file("picture.png", false), "public.png");
        assert_eq!(uti_for_file("photo.JPG", false), "public.jpeg");
        assert_eq!(uti_for_file("animation.gif", false), "com.compuserve.gif");
        assert_eq!(uti_for_file("manual.pdf", false), "com.adobe.pdf");
        assert_eq!(uti_for_file("bundle.zip", false), "public.zip-archive");
        assert_eq!(uti_for_file("archive.tar", false), "public.tar-archive");
        assert_eq!(
            uti_for_file("compressed.gz", false),
            "org.gnu.gnu-zip-archive"
        );
        assert_eq!(uti_for_file("track.mp3", false), "public.mp3");
        assert_eq!(uti_for_file("video.mp4", false), "public.mpeg-4");
        assert_eq!(
            uti_for_file("installer.dmg", false),
            "com.apple.disk-image-udif"
        );
        assert_eq!(uti_for_file("unknown.xyz", false), "public.data");
        assert_eq!(uti_for_file("noextension", false), "public.data");
    }

    #[test]
    fn directory_always_resolves_to_folder_uti() {
        assert_eq!(uti_for_file("Photos", true), "public.folder");
        assert_eq!(uti_for_file("Photos.zip", true), "public.folder");
        assert_eq!(uti_for_file("Docs.pdf", true), "public.folder");
    }

    #[test]
    fn cleans_file_names_safely() {
        assert_eq!(clean_file_name("regular.txt"), "regular.txt");
        assert_eq!(clean_file_name("/var/log/system.log"), "system.log");
        assert_eq!(clean_file_name("folder\\nested\\doc.pdf"), "doc.pdf");
        assert_eq!(clean_file_name(""), "download");
        assert_eq!(clean_file_name("."), "download");
        assert_eq!(clean_file_name(".."), "download");
        assert_eq!(clean_file_name("  spaced.txt  "), "spaced.txt");
    }
}
