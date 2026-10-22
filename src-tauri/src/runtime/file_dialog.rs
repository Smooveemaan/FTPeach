//! The native file dialogs: the Save dialog, for the commands that write a
//! file the user names, and the pickers that let the user choose one.
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Asks where to save a file, offering `file_name`; `None` when the user
/// cancels. The desktop tests answer for the user: a test build saves into the
/// folder they name, since nothing can drive the native dialog.
pub(crate) async fn save_path(
    app: &AppHandle,
    title: &str,
    file_name: String,
    filter: (&str, &[&str]),
) -> Option<String> {
    #[cfg(feature = "smoke-test")]
    if let Some(folder) = super::e2e_browser::save_folder() {
        return Some(folder.join(file_name).to_string_lossy().into_owned());
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(title)
        .set_file_name(file_name)
        .add_filter(filter.0, filter.1)
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    rx.await.ok().flatten().map(|path| path.to_string())
}

pub(crate) type Picked = tokio::sync::oneshot::Sender<Option<tauri_plugin_dialog::FilePath>>;

/// The path the user picks in the dialog `show` opens, `None` if cancelled.
pub(crate) async fn picked(show: impl FnOnce(Picked)) -> Option<String> {
    // The desktop tests answer for the user, since nothing can drive the native dialog.
    #[cfg(feature = "smoke-test")]
    if let Some(answer) = super::e2e_browser::picked_path() {
        return answer;
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    show(tx);
    rx.await.ok().flatten().map(|p| p.to_string())
}
