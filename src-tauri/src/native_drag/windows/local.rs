//! Dragging files that are already on this computer out of a pane: a shell
//! data object over their paths, which Explorer copies or moves itself.
use super::*;

/// PIDLs owned by us until the shell item array has copied them, freed with
/// `CoTaskMemFree` however the build below exits.
pub(super) struct ParsedPaths(Vec<*const ITEMIDLIST>);
impl Drop for ParsedPaths {
    fn drop(&mut self) {
        for pidl in self.0.drain(..) {
            unsafe { CoTaskMemFree(Some(pidl.cast())) };
        }
    }
}

/// A shell data object for files that already exist on disk — the ordinary
/// `CF_HDROP`-style drag Explorer itself uses, and everything a local pane
/// needs. The virtual/lazy machinery above exists only because remote files
/// have no bytes on disk to hand over; here the shell copies real paths and
/// never calls back into us, so this can be built on the main thread right
/// before `DoDragDrop` instead of on a marshaling keeper thread.
pub(super) fn local_paths_data_object(paths: &[String]) -> anyhow::Result<IDataObject> {
    let mut parsed = ParsedPaths(Vec::with_capacity(paths.len()));
    for path in paths {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
        unsafe {
            SHParseDisplayName(
                PCWSTR(wide.as_ptr()),
                None,
                &mut pidl,
                0,
                Some(std::ptr::null_mut()),
            )
        }
        .map_err(|error| anyhow::anyhow!("{path}: {error}"))?;
        parsed.0.push(pidl.cast_const());
    }
    let items: IShellItemArray = unsafe { SHCreateShellItemArrayFromIDLists(&parsed.0) }
        .map_err(|error| anyhow::anyhow!("Building the drag item list failed: {error}"))?;
    unsafe { items.BindToHandler(None, &BHID_DataObject) }
        .map_err(|error| anyhow::anyhow!("Building the drag data object failed: {error}"))
}

/// Runs a native drag-and-drop session for files that already live on disk,
/// resolving once the user drops or cancels. Copy-only on purpose: the OS
/// would otherwise offer a same-volume move, which deletes what the user is
/// looking at in the pane on a gesture they meant as "put a copy over there".
pub(crate) async fn start_local_drag(
    window: tauri::Window,
    paths: Vec<String>,
) -> anyhow::Result<()> {
    let (tx, rx) = oneshot::channel();
    window.run_on_main_thread(move || {
        let result = (|| -> anyhow::Result<()> {
            init_ole().map_err(|e| anyhow::anyhow!("OleInitialize failed: {e}"))?;
            let data_object = local_paths_data_object(&paths)?;
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
