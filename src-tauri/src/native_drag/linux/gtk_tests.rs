use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::{fs, process::Command, time::Instant};

const TEST: &str =
    "native_drag::linux::gtk_tests::native_gtk_drag_exchanges_paths_without_blocking_the_source";

// A separate process represents the desktop: it negotiates GTK data and reads the actual files.
const RECEIVER: &str = r#"
import ctypes, pathlib, sys, threading
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, GLib, Gdk
root = pathlib.Path(sys.argv[1])
window = Gtk.Window()
window.move(450, 20)
window.set_default_size(250, 200)
window.drag_dest_set(Gtk.DestDefaults.MOTION | Gtk.DestDefaults.HIGHLIGHT, [Gtk.TargetEntry.new('text/uri-list', 0, 0)], Gdk.DragAction.COPY)
def drop(widget, context, x, y, time):
    widget.drag_get_data(context, Gdk.Atom.intern('text/uri-list', False), time)
    return True
window.connect('drag-drop', drop)
def receive(widget, context, x, y, selection, info, time):
    from gi.repository import Gio
    paths = [Gio.File.new_for_uri(uri).get_path() for uri in selection.get_uris()]
    assert Gio.File.new_for_path(paths[0]).query_exists(None)
    Gio.File.new_for_path(paths[0]).query_info('standard::type,standard::size,id::filesystem', Gio.FileQueryInfoFlags.NONE, None)
    def copy():
        Gio.File.new_for_path(paths[0]).copy(Gio.File.new_for_path(str(root / 'pending')), Gio.FileCopyFlags.NONE, None, None)
        def finish():
            Gtk.drag_finish(context, True, False, time)
            Gdk.Display.get_default().flush()
            root.joinpath('pending').replace(root.joinpath('received'))
            return False
        GLib.idle_add(finish)
    threading.Thread(target=copy, daemon=True).start()
window.connect('drag-data-received', receive)
window.show_all()
x11 = ctypes.CDLL('libX11.so.6')
xtst = ctypes.CDLL('libXtst.so.6')
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XFlush.argtypes = [ctypes.c_void_p]
display = x11.XOpenDisplay(None)
xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
def step(x, y, button=None):
    xtst.XTestFakeMotionEvent(display, -1, x, y, 0)
    if button is not None: xtst.XTestFakeButtonEvent(display, 1, button, 0)
    x11.XFlush(display)
    return False
GLib.timeout_add(400, step, 100, 100, 1)
GLib.timeout_add(700, step, 300, 100)
GLib.timeout_add(850, step, 500, 100)
if sys.argv[2] == 'cancel':
    def cancel():
        xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
        x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        key = x11.XKeysymToKeycode(display, 0xff1b)
        xtst.XTestFakeKeyEvent(display, key, 1, 0)
        xtst.XTestFakeKeyEvent(display, key, 0, 0)
        x11.XFlush(display)
        return False
    GLib.timeout_add(900, cancel)
GLib.timeout_add(1100, step, 500, 100, 0)
GLib.timeout_add(1400, step, 100, 100, 1)
GLib.timeout_add(1500, step, 100, 100, 0)
root.joinpath('receiver-ready').touch()
Gtk.main()
"#;

#[test]
fn native_gtk_drag_exchanges_paths_without_blocking_the_source() {
    if std::env::var_os("FTPEACH_GTK_DRAG_CHILD").is_none() {
        let output = Command::new("xvfb-run")
            .args(["-a"])
            .arg(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture"])
            .env("FTPEACH_GTK_DRAG_CHILD", "1")
            .env("GDK_BACKEND", "x11")
            .env_remove("WAYLAND_DISPLAY")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    gtk::init().unwrap();
    let app = gtk::Application::new(None, gio::ApplicationFlags::NON_UNIQUE);
    app.register(None::<&gio::Cancellable>).unwrap();
    for scenario in ["local", "remote", "unknown-size", "cancel"] {
        let remote = scenario != "local";
        let root = std::env::temp_dir().join(format!("ftpeach-gtk-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let mounted = filesystem::Mounted::new().unwrap();
        let expected = vec![b'x'; 262_145];
        let heartbeat = Arc::new(AtomicUsize::new(0));
        let loads = Arc::new(AtomicUsize::new(0));
        let clicks = Arc::new(AtomicUsize::new(0));
        let gesture_finished = Arc::new(AtomicUsize::new(0));
        let path = if remote {
            let bytes = expected.clone();
            let heartbeat = heartbeat.clone();
            let loads = loads.clone();
            let clicks = clicks.clone();
            let gesture_finished = gesture_finished.clone();
            mounted
                .add_directory(
                    &[test_file(
                        "remote.txt",
                        false,
                        if scenario == "unknown-size" {
                            None
                        } else {
                            Some(1)
                        },
                    )],
                    Box::new(move |dir, _| {
                        loads.fetch_add(1, Ordering::SeqCst);
                        let before = heartbeat.load(Ordering::SeqCst);
                        let deadline = Instant::now() + Duration::from_secs(2);
                        while heartbeat.load(Ordering::SeqCst) < before + 5
                            || clicks.load(Ordering::SeqCst) == 0
                            || gesture_finished.load(Ordering::SeqCst) != 1
                        {
                            if Instant::now() >= deadline {
                                return Err(crate::ipc::CommandError::new(
                                    crate::ipc::ErrorCode::Internal,
                                    "The source did not accept a mouse click during a desktop read",
                                ));
                            }
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        fs::write(dir.join("remote.txt"), bytes)?;
                        Ok(())
                    }),
                )
                .unwrap()
                .remove(0)
        } else {
            let path = root.join("local #%.txt");
            fs::write(&path, &expected).unwrap();
            path.to_string_lossy().into_owned()
        };
        let source = gtk::ApplicationWindow::new(&app);
        source.move_(20, 20);
        source.set_default_size(250, 200);
        source.add_events(gdk::EventMask::BUTTON_PRESS_MASK);
        let context = Rc::new(RefCell::new(None::<gdk::DragContext>));
        let started_context = context.clone();
        source.connect_drag_begin(move |_, context| {
            *started_context.borrow_mut() = Some(context.clone());
        });
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        let tx = RefCell::new(Some(tx));
        let data = uri_list(&[path]).unwrap();
        let ended = Rc::new(Cell::new(false));
        let cancelled = Rc::new(Cell::new(false));
        let motion_ended = ended.clone();
        let motion_cancelled = cancelled.clone();
        let visible_icon = Rc::new(Cell::new(false));
        let clicked_icon = visible_icon.clone();
        source.connect_button_press_event(move |widget, event| {
            if event.event_type() != gdk::EventType::ButtonPress {
                return glib::Propagation::Proceed;
            }
            PRESS.with(|press| *press.borrow_mut() = Some(std::ops::Deref::deref(event).clone()));
            if let Some(tx) = tx.borrow_mut().take() {
                let widget = widget.clone();
                let data = data.clone();
                let ended = motion_ended.clone();
                let cancelled = motion_cancelled.clone();
                let gesture_finished = gesture_finished.clone();
                glib::timeout_add_local_once(Duration::from_millis(50), move || {
                    begin(&widget, data, tx, move |end, cancel| {
                        ended.set(end);
                        cancelled.set(cancel);
                        if end {
                            gesture_finished.fetch_add(1, Ordering::SeqCst);
                        }
                    })
                });
            } else {
                clicked_icon.set(
                    context
                        .borrow()
                        .as_ref()
                        .and_then(|context| context.drag_window())
                        .is_some_and(|icon| icon.is_visible()),
                );
                clicks.fetch_add(1, Ordering::SeqCst);
            }
            glib::Propagation::Proceed
        });
        source.show_all();
        let timer = glib::timeout_add_local(Duration::from_millis(10), move || {
            heartbeat.fetch_add(1, Ordering::SeqCst);
            glib::ControlFlow::Continue
        });
        let mut receiver = Command::new("/usr/bin/python3")
            .args(["-c", RECEIVER])
            .arg(&root)
            .arg(scenario)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !root.join("received").exists()
            && !(scenario == "cancel" && ended.get())
            && Instant::now() < deadline
        {
            glib::MainContext::default().iteration(false);
            std::thread::sleep(Duration::from_millis(1));
        }
        let _ = receiver.kill();
        receiver.wait().unwrap();
        timer.remove();
        if scenario == "cancel" {
            assert!(cancelled.get(), "Escape did not cancel the native drag");
            assert_eq!(
                loads.load(Ordering::SeqCst),
                0,
                "cancelled drag downloaded files"
            );
            assert!(!root.join("received").exists());
        } else {
            assert!(
                root.join("received").exists(),
                "native GTK {scenario} drag did not arrive"
            );
            assert!(
                fs::read(root.join("received")).unwrap() == expected,
                "dragged contents differ"
            );
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match rx.try_recv() {
                Ok(result) => {
                    result.unwrap();
                    break;
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                    panic!("drag completion channel closed")
                }
                Err(_) => assert!(Instant::now() < deadline, "native drag did not complete"),
            }
            glib::MainContext::default().iteration(false);
        }
        source.close();
        assert!(
            !visible_icon.get(),
            "The drag icon remained visible after release"
        );
        assert!(
            cancelled.get(),
            "an OS drop must not be replayed as an in-app copy"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
