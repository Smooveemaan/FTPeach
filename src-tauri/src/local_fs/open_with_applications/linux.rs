use super::ApplicationCandidate;
use gtk::{gio, prelude::*};
use std::path::Path;

/// Lists desktop applications for the name's MIME type, with the default first.
pub fn query_applications(file_name: &str) -> Vec<ApplicationCandidate> {
    let (content_type, _) = gio::content_type_guess(Some(file_name), &[]);
    let default = gio::AppInfo::default_for_type(&content_type, false);
    let mut apps = gio::AppInfo::all_for_type(&content_type);
    if let Some(default) = &default {
        apps.insert(0, default.clone());
    }
    let mut result = Vec::<ApplicationCandidate>::new();
    for app in apps {
        let Some(desktop) = app.downcast_ref::<gio::DesktopAppInfo>() else {
            continue;
        };
        let Some(path) = desktop.filename() else {
            continue;
        };
        let path = path.to_string_lossy().into_owned();
        if !app.should_show() || result.iter().any(|candidate| candidate.path == path) {
            continue;
        }
        result.push(ApplicationCandidate {
            name: app.display_name().into(),
            path,
            is_default: default.as_ref().is_some_and(|default| app.equal(default)),
        });
    }
    result.sort_by_key(|app| (!app.is_default, app.name.to_lowercase()));
    result
}

/// Launches a validated desktop entry using GIO's Exec field expansion.
pub fn launch(application: &Path, file: &Path) -> anyhow::Result<()> {
    let app = gio::DesktopAppInfo::from_filename(application)
        .ok_or_else(|| anyhow::anyhow!("The desktop application is unavailable"))?;
    app.launch(&[gio::File::for_path(file)], None::<&gio::AppLaunchContext>)?;
    Ok(())
}

/// Opens a modal system chooser without changing the default application.
pub async fn choose<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    path: &Path,
) -> anyhow::Result<()> {
    let owner = window.clone();
    let path = path.to_path_buf();
    let (tx, rx) = tokio::sync::oneshot::channel();
    window.run_on_main_thread(move || {
        let parent = match owner.gtk_window() {
            Ok(parent) => parent,
            Err(error) => {
                let _ = tx.send(Err(error.into()));
                return;
            }
        };
        let file = gio::File::for_path(&path);
        let dialog = gtk::AppChooserDialog::new(
            Some(&parent),
            gtk::DialogFlags::MODAL | gtk::DialogFlags::DESTROY_WITH_PARENT,
            &file,
        );
        let tx = std::cell::RefCell::new(Some(tx));
        dialog.connect_response(move |dialog, response| {
            let Some(tx) = tx.borrow_mut().take() else {
                return;
            };
            let result = if response == gtk::ResponseType::Ok {
                dialog
                    .app_info()
                    .ok_or_else(|| anyhow::anyhow!("No application selected"))
                    .and_then(|app| {
                        let context = dialog.display().app_launch_context();
                        app.launch(std::slice::from_ref(&file), context.as_ref())
                            .map_err(Into::into)
                    })
            } else {
                Ok(())
            };
            dialog.close();
            let _ = tx.send(result);
        });
        dialog.show();
    })?;
    rx.await?
}

#[cfg(test)]
mod tests;
