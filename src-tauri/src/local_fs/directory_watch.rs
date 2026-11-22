//! Observe the two visible local folders after the desktop finishes asynchronous moves.
use anyhow::{Result, ensure};
use gtk::{gio, prelude::*};
use std::{cell::RefCell, path::Path};
use tauri::Emitter;

thread_local! {
    static MONITORS: RefCell<Vec<gio::FileMonitor>> = const { RefCell::new(Vec::new()) };
}

fn watch(
    paths: &[String],
    changed: impl Fn(&str) + Clone + 'static,
) -> Result<Vec<gio::FileMonitor>> {
    ensure!(
        paths.len() <= 2,
        "Only visible local folders can be watched"
    );
    ensure!(
        paths
            .iter()
            .all(|path| Path::new(path).is_absolute() && !path.contains('\0')),
        "Invalid local folder path"
    );
    paths
        .iter()
        .map(|path| {
            let monitor = gio::File::for_path(path)
                .monitor_directory(gio::FileMonitorFlags::WATCH_MOVES, gio::Cancellable::NONE)?;
            monitor.set_rate_limit(100);
            let path = path.clone();
            let changed = changed.clone();
            monitor.connect_changed(move |_, _, _, event| {
                if matches!(
                    event,
                    gio::FileMonitorEvent::Created
                        | gio::FileMonitorEvent::Deleted
                        | gio::FileMonitorEvent::Renamed
                        | gio::FileMonitorEvent::MovedIn
                        | gio::FileMonitorEvent::MovedOut
                ) {
                    changed(&path);
                }
            });
            Ok(monitor)
        })
        .collect()
}

pub(crate) async fn replace(window: tauri::Window, paths: Vec<String>) -> Result<()> {
    let owner = window.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    window.run_on_main_thread(move || {
        let result = watch(&paths, move |path| {
            let _ = owner.emit("fs:directoryChanged", path);
        })
        .map(|monitors| {
            MONITORS.with(|current| {
                for monitor in current.replace(monitors) {
                    monitor.cancel();
                }
            })
        });
        let _ = tx.send(result);
    })?;
    rx.await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use gtk::glib;
    use std::{
        cell::Cell,
        rc::Rc,
        time::{Duration, Instant},
    };

    #[test]
    fn observes_a_move_after_the_drag_has_finished_and_stops_when_cancelled() {
        let context = glib::MainContext::new();
        context
            .with_thread_default(|| {
                let root = std::env::temp_dir()
                    .join(format!("ftpeach-directory-watch-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir(&root).unwrap();
                let source = root.join("source");
                std::fs::create_dir(&source).unwrap();
                std::fs::write(source.join("file.txt"), b"contents").unwrap();
                let path = source.to_str().unwrap().to_owned();
                let changes = Rc::new(Cell::new(0));
                let received = changes.clone();
                let expected = path.clone();
                let monitors = watch(&[path], move |path| {
                    assert_eq!(path, expected);
                    received.set(received.get() + 1);
                })
                .unwrap();
                std::fs::rename(source.join("file.txt"), root.join("file.txt")).unwrap();
                let deadline = Instant::now() + Duration::from_secs(3);
                while changes.get() == 0 && Instant::now() < deadline {
                    context.iteration(false);
                    std::thread::sleep(Duration::from_millis(5));
                }
                assert!(
                    changes.get() > 0,
                    "Moving the source must notify its folder"
                );
                assert_eq!(std::fs::read(root.join("file.txt")).unwrap(), b"contents");
                for monitor in monitors {
                    monitor.cancel();
                    assert!(monitor.is_cancelled());
                }
                std::fs::remove_dir_all(root).unwrap();
            })
            .unwrap();
    }

    #[test]
    fn rejects_relative_nul_and_more_than_two_paths() {
        for paths in [
            vec!["relative".to_owned()],
            vec!["/tmp/\0".to_owned()],
            vec!["/tmp".to_owned(); 3],
        ] {
            assert!(watch(&paths, |_| {}).is_err());
        }
        assert!(watch(&[], |_| {}).unwrap().is_empty());
    }
}
