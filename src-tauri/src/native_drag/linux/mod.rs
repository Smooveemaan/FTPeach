//! GTK exports local paths; a read-only FUSE view materializes remote files off the UI thread.
mod filesystem;
#[cfg(test)]
mod gtk_tests;
#[cfg(test)]
mod wayland_tests;

use anyhow::{Context, Result, ensure};
use gtk::{gdk, gio, glib, prelude::*};
use std::{
    cell::{Cell, RefCell},
    collections::HashSet,
    path::Path,
    rc::Rc,
    sync::Mutex,
    time::Duration,
};
use tauri::{Emitter, Manager, Window};

thread_local! {
    static PRESS: RefCell<Option<gdk::Event>> = const { RefCell::new(None) };
}

#[derive(Default)]
struct Drags(Mutex<Option<filesystem::Mounted>>);

/// Retains the real pointer event, including the Wayland drag serial, across IPC.
pub(crate) fn install(window: &tauri::WebviewWindow) {
    window.app_handle().manage(Drags::default());
    if let Err(error) = window.with_webview(|webview| {
        webview.inner().connect_event(|_, event| {
            if event.event_type() == gdk::EventType::ButtonPress {
                PRESS.with(|press| *press.borrow_mut() = Some(event.clone()));
            }
            glib::Propagation::Proceed
        });
    }) {
        log::warn!("Could not retain native drag events: {error}");
    }
}

pub(crate) fn cleanup(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Drags>() {
        state.0.lock().unwrap().take();
    }
}

pub(crate) async fn start_drag(
    window: Window,
    files: Vec<super::DragOutFile>,
    loader: filesystem::Loader,
) -> Result<()> {
    validate_names(
        &files
            .iter()
            .map(|file| file.name.clone())
            .collect::<Vec<_>>(),
    )?;
    let app = window.app_handle().clone();
    let paths = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Drags>();
        let mut mounted = state.0.lock().unwrap();
        if mounted.is_none() {
            *mounted = Some(filesystem::Mounted::new()?);
        }
        mounted.as_ref().unwrap().add_directory(&files, loader)
    })
    .await??;
    start_local_drag(window, paths).await
}

fn validate_names(names: &[String]) -> Result<()> {
    ensure!(
        !names.is_empty() && names.len() <= 100_000,
        "Invalid drag selection size"
    );
    let mut unique = HashSet::new();
    for name in names {
        ensure!(
            crate::security::connection_guard::is_safe_path_segment(name) && !name.contains('\0'),
            "Unsafe drag entry name"
        );
        ensure!(
            name.len() <= 255 && unique.insert(name),
            "Duplicate or oversized drag entry name"
        );
    }
    Ok(())
}

fn uri_list(paths: &[String]) -> Result<Vec<u8>> {
    ensure!(!paths.is_empty(), "No files to drag");
    let mut list = String::new();
    for path in paths {
        ensure!(
            Path::new(path).is_absolute() && !path.contains('\0'),
            "Invalid drag path"
        );
        list.push_str(gio::File::for_path(path).uri().as_str());
        list.push_str("\r\n");
    }
    Ok(list.into_bytes())
}

pub(crate) async fn start_local_drag(window: Window, paths: Vec<String>) -> Result<()> {
    let data = uri_list(&paths)?;
    let owner = window.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    window.run_on_main_thread(move || match owner.gtk_window() {
        Ok(widget) => {
            let source = widget.clone();
            begin(&widget, data, tx, move |ended, cancelled| {
                if let Some(surface) = source.window()
                    && let Some(pointer) = source
                        .display()
                        .default_seat()
                        .and_then(|seat| seat.pointer())
                {
                    let (under_pointer, x, y, _) = surface.device_position(&pointer);
                    let (x, y) = if under_pointer.is_some() {
                        (x, y)
                    } else {
                        (-1, -1)
                    };
                    let scale = f64::from(source.scale_factor());
                    let _ = owner.emit(
                        "drag-out-motion",
                        super::DragMotion {
                            x: f64::from(x) * scale,
                            y: f64::from(y) * scale,
                            ended,
                            cancelled,
                        },
                    );
                }
            });
        }
        Err(error) => {
            let _ = tx.send(Err(error.into()));
        }
    })?;
    rx.await.context("Native drag did not finish")?
}

fn begin(
    widget: &gtk::ApplicationWindow,
    data: Vec<u8>,
    tx: tokio::sync::oneshot::Sender<Result<()>>,
    motion: impl Fn(bool, bool) + 'static,
) {
    let sender = Rc::new(RefCell::new(Some(tx)));
    let handlers = Rc::new(RefCell::new(Vec::new()));
    let active_context = Rc::new(RefCell::new(None::<gdk::DragContext>));
    let data_context = active_context.clone();
    let targets = gtk::TargetList::new(&[gtk::TargetEntry::new(
        "text/uri-list",
        gtk::TargetFlags::OTHER_APP,
        0,
    )]);
    handlers.borrow_mut().push(
        widget.connect_drag_data_get(move |_, context, selection, _, _| {
            if data_context.borrow().as_ref() != Some(context) {
                return;
            }
            // Avoid GIO's synchronous portal export opening a lazy FUSE file on the GTK thread.
            selection.set(&gdk::Atom::intern("text/uri-list"), 8, &data);
        }),
    );
    let delete_context = active_context.clone();
    handlers
        .borrow_mut()
        .push(widget.connect_drag_data_delete(move |widget, context| {
            if delete_context.borrow().as_ref() == Some(context)
                && widget.display().type_().name() == "GdkWaylandDisplay"
            {
                // workaround: GTK3's NULL DELETE reply leaves Plasma waiting for all offered formats.
                gdk::property_change(
                    &context.source_window(),
                    &gdk::Atom::intern("GDK_SELECTION"),
                    &gdk::Atom::intern("DELETE"),
                    8,
                    gdk::PropMode::Replace,
                    gdk::ChangeData::UChars(&[]),
                );
            }
        }));
    let end_sender = sender.clone();
    let end_handlers = handlers.clone();
    let cancelled = Rc::new(Cell::new(false));
    let failed_cancelled = cancelled.clone();
    let failed_context = active_context.clone();
    handlers
        .borrow_mut()
        .push(widget.connect_drag_failed(move |_, context, result| {
            if failed_context.borrow().as_ref() == Some(context) {
                failed_cancelled.set(result == gtk::DragResult::UserCancelled);
            }
            glib::Propagation::Proceed
        }));
    let motion = Rc::new(motion);
    let timer_motion = motion.clone();
    let timer = Rc::new(RefCell::new(Some(glib::timeout_add_local(
        Duration::from_millis(16),
        move || {
            timer_motion(false, false);
            glib::ControlFlow::Continue
        },
    ))));
    let end_timer = timer.clone();
    let finish_gesture = Rc::new(move |cancelled| {
        if let Some(timer) = end_timer.borrow_mut().take() {
            timer.remove();
        }
        if let Some(tx) = end_sender.borrow_mut().take() {
            motion(true, cancelled);
            let _ = tx.send(Ok(()));
        }
    });
    let end_gesture = finish_gesture.clone();
    let end_context = active_context.clone();
    handlers
        .borrow_mut()
        .push(widget.connect_drag_end(move |widget, context| {
            if end_context.borrow().as_ref() != Some(context) {
                return;
            }
            // An accepted OS drop must never also submit an in-app copy.
            end_gesture(cancelled.get() || !context.selected_action().is_empty());
            for id in end_handlers.borrow_mut().drain(..) {
                widget.disconnect(id);
            }
            end_context.borrow_mut().take();
        }));
    let press = PRESS.with(|press| press.borrow().clone());
    if let Some(context) = widget.drag_begin_with_coordinates(
        &targets,
        gdk::DragAction::COPY,
        1,
        press.as_ref(),
        -1,
        -1,
    ) {
        *active_context.borrow_mut() = Some(context.clone());
        context.drag_set_icon_name("text-x-generic", 0, 0);
        context.connect_drop_performed(move |context, _| {
            // The target may wait for all file bytes before acknowledging the drop.
            if let Some(icon) = context.drag_window() {
                icon.hide();
            }
            finish_gesture(true);
        });
    } else {
        if let Some(timer) = timer.borrow_mut().take() {
            timer.remove();
        }
        for id in handlers.borrow_mut().drain(..) {
            widget.disconnect(id);
        }
        if let Some(tx) = sender.borrow_mut().take() {
            let _ = tx.send(Err(anyhow::anyhow!(
                "The desktop refused to start the drag"
            )));
        }
    }
}

#[cfg(test)]
fn test_file(name: &str, is_directory: bool, size: Option<u64>) -> super::DragOutFile {
    super::DragOutFile {
        name: name.into(),
        remote_path: format!("/{name}"),
        size,
        is_directory,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_roots_cannot_escape_the_private_cache() {
        assert!(validate_names(&["a b.txt".into(), "A b.txt".into()]).is_ok());
        assert!(validate_names(&["same".into(), "same".into()]).is_err());
        for name in ["", ".", "..", "../outside", "/absolute", "a\\b", "a\0b"] {
            assert!(validate_names(&[name.into()]).is_err(), "{name}");
        }
        assert!(validate_names(&["a".repeat(256)]).is_err());
    }

    #[test]
    fn local_uris_preserve_names_and_cannot_inject_extra_files() {
        let data = uri_list(&["/tmp/a b#%;\nname.txt".into(), "/tmp/folder".into()]).unwrap();
        assert_eq!(
            String::from_utf8(data).unwrap(),
            "file:///tmp/a%20b%23%25%3B%0Aname.txt\r\nfile:///tmp/folder\r\n"
        );
        for paths in [vec![], vec!["relative".into()], vec!["/tmp/a\0b".into()]] {
            assert!(uri_list(&paths).is_err());
        }
    }
}
