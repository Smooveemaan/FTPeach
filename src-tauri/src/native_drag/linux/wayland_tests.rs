use super::*;
use std::{fs, process::Command, time::Instant};

const TEST: &str = "native_drag::linux::wayland_tests::copy_drag_answers_eager_delete_on_wayland";

const LAUNCHER: &str = r#"
import ctypes, os, pathlib, signal, subprocess, sys, tempfile, time

with tempfile.TemporaryDirectory(prefix='ftpeach-wayland-') as directory:
    root = pathlib.Path(directory)
    (root / 'receiver.c').write_text(sys.argv[3])
    xml = '/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml'
    subprocess.run(['wayland-scanner', 'client-header', xml, str(root / 'xdg-shell.h')], check=True)
    subprocess.run(['wayland-scanner', 'private-code', xml, str(root / 'xdg-shell.c')], check=True)
    subprocess.run(['cc', '-Wall', '-Wextra', '-o', str(root / 'receiver'), str(root / 'receiver.c'), str(root / 'xdg-shell.c'), '-lwayland-client'], check=True)
    runtime = root / 'runtime'
    runtime.mkdir(mode=0o700)
    env = dict(os.environ, XDG_RUNTIME_DIR=str(runtime))
    socket = 'ftpeach-test'
    processes = []
    with (root / 'weston.log').open('w+') as compositor_log, (root / 'test.log').open('w+') as test_log:
        try:
            weston = subprocess.Popen([
                'weston', '--backend=x11-backend.so', '--shell=kiosk-shell.so',
                '--socket=' + socket, '--width=800', '--height=600',
                '--idle-time=0', '--no-config', '--use-pixman',
            ], env=env, stdout=compositor_log, stderr=subprocess.STDOUT, start_new_session=True)
            processes.append(weston)
            deadline = time.monotonic() + 20
            while not (runtime / socket).exists():
                assert weston.poll() is None, 'Weston exited before opening its socket'
                assert time.monotonic() < deadline, 'Weston socket timed out'
                time.sleep(0.01)
            env.update(GDK_BACKEND='wayland', WAYLAND_DISPLAY=socket, FTPEACH_WAYLAND_DRAG_ROOT=str(root), FTPEACH_WAYLAND_DRAG_RECEIVER=str(root / 'receiver'))
            child = subprocess.Popen([sys.argv[1], '--exact', sys.argv[2], '--nocapture'],
                env=env, stdout=test_log, stderr=subprocess.STDOUT, start_new_session=True)
            processes.append(child)

            def wait_for(name):
                while not (root / name).exists():
                    assert child.poll() is None, 'Rust test exited while waiting for ' + name
                    assert time.monotonic() < deadline, 'Timed out waiting for ' + name
                    time.sleep(0.01)

            x11 = ctypes.CDLL('libX11.so.6')
            xtst = ctypes.CDLL('libXtst.so.6')
            x11.XOpenDisplay.restype = ctypes.c_void_p
            x11.XFlush.argtypes = [ctypes.c_void_p]
            xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
            xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
            display = x11.XOpenDisplay(None)
            assert display, 'XTest could not open the outer Xvfb display'

            def move(x):
                xtst.XTestFakeMotionEvent(display, -1, x, 300, 0)
                x11.XFlush(display)

            def button(pressed):
                xtst.XTestFakeButtonEvent(display, 1, pressed, 0)
                x11.XFlush(display)

            wait_for('source-ready')
            # Allow the first fullscreen surface to be presented before pressing.
            time.sleep(0.2)
            move(300)
            time.sleep(0.05)
            button(1)
            wait_for('receiver-ready')
            time.sleep(0.2)
            move(550)
            time.sleep(0.05)
            move(560)
            # Keep the grab alive until DELETE has actually completed.
            wait_for('delete-received')
            button(0)
            code = child.wait(timeout=max(1, deadline - time.monotonic()))
            assert code == 0, 'Rust test failed: ' + str(code)
        except BaseException:
            for name, log in [('Weston', compositor_log), ('Rust/receiver', test_log)]:
                log.flush()
                log.seek(0)
                print(name + ':\n' + log.read(), file=sys.stderr)
            raise
        finally:
            for process in reversed(processes):
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
"#;

const RECEIVER: &str = r#"
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <wayland-client.h>
#include "xdg-shell.h"

static struct wl_display *display;
static struct wl_compositor *compositor;
static struct wl_shm *shm;
static struct wl_seat *seat;
static struct wl_data_device_manager *manager;
static struct xdg_wm_base *wm;
static struct wl_surface *surface;
static struct wl_buffer *buffer;
static struct wl_data_offer *offer;
static const char *root;
static int transfer = -1, phase, mapped;
static size_t length;
static char bytes[8192];

static void path(char *out, const char *name) { assert(snprintf(out, 4096, "%s/%s", root, name) < 4096); }
static void mark(const char *name) { char p[4096]; path(p, name); FILE *f = fopen(p, "w"); assert(f); assert(fclose(f) == 0); }
static void request(const char *mime, int next) {
    int pipes[2]; assert(pipe2(pipes, O_CLOEXEC | O_NONBLOCK) == 0);
    assert(transfer == -1); transfer = pipes[0]; phase = next; length = 0;
    wl_data_offer_receive(offer, mime, pipes[1]); close(pipes[1]);
    assert(wl_display_flush(display) >= 0 || errno == EAGAIN);
}
static void offered(void *p, struct wl_data_offer *o, const char *mime) { (void)p; (void)o; (void)mime; }
static void actions(void *p, struct wl_data_offer *o, uint32_t value) { (void)p; (void)o; (void)value; }
static const struct wl_data_offer_listener offer_listener = { offered, actions, actions };
static void new_offer(void *p, struct wl_data_device *d, struct wl_data_offer *o) {
    (void)p; (void)d; offer = o; wl_data_offer_add_listener(o, &offer_listener, NULL);
}
static void enter(void *p, struct wl_data_device *d, uint32_t serial, struct wl_surface *s, wl_fixed_t x, wl_fixed_t y, struct wl_data_offer *o) {
    (void)p; (void)d; (void)s; (void)x; (void)y; assert(o == offer);
    wl_data_offer_set_actions(o, WL_DATA_DEVICE_MANAGER_DND_ACTION_COPY, WL_DATA_DEVICE_MANAGER_DND_ACTION_COPY);
    wl_data_offer_accept(o, serial, "text/uri-list");
    request("DELETE", 1);
}
static void leave(void *p, struct wl_data_device *d) { (void)p; (void)d; }
static void motion(void *p, struct wl_data_device *d, uint32_t t, wl_fixed_t x, wl_fixed_t y) { (void)p; (void)d; (void)t; (void)x; (void)y; }
static void drop(void *p, struct wl_data_device *d) { (void)p; (void)d; assert(phase == 1 && transfer == -1); request("text/uri-list", 2); }
static void selection(void *p, struct wl_data_device *d, struct wl_data_offer *o) { (void)p; (void)d; (void)o; }
static const struct wl_data_device_listener device_listener = { new_offer, enter, leave, motion, drop, selection };
static void ping(void *p, struct xdg_wm_base *w, uint32_t serial) { (void)p; xdg_wm_base_pong(w, serial); }
static const struct xdg_wm_base_listener wm_listener = { ping };
static void global(void *p, struct wl_registry *r, uint32_t id, const char *name, uint32_t version) {
    (void)p;
    if (!strcmp(name, "wl_compositor")) compositor = wl_registry_bind(r, id, &wl_compositor_interface, 1);
    else if (!strcmp(name, "wl_shm")) shm = wl_registry_bind(r, id, &wl_shm_interface, 1);
    else if (!strcmp(name, "wl_seat")) seat = wl_registry_bind(r, id, &wl_seat_interface, 1);
    else if (!strcmp(name, "wl_data_device_manager")) { assert(version >= 3); manager = wl_registry_bind(r, id, &wl_data_device_manager_interface, 3); }
    else if (!strcmp(name, "xdg_wm_base")) { wm = wl_registry_bind(r, id, &xdg_wm_base_interface, 1); xdg_wm_base_add_listener(wm, &wm_listener, NULL); }
}
static void removed(void *p, struct wl_registry *r, uint32_t id) { (void)p; (void)r; (void)id; }
static const struct wl_registry_listener registry_listener = { global, removed };
static void configure(void *p, struct xdg_surface *s, uint32_t serial) {
    (void)p; xdg_surface_ack_configure(s, serial);
    if (!mapped) {
        wl_surface_attach(surface, buffer, 0, 0);
        wl_surface_damage(surface, 0, 0, 800, 600); wl_surface_commit(surface);
        mapped = 1; mark("receiver-ready");
    }
}
static const struct xdg_surface_listener surface_listener = { configure };
static void completed(void) {
    close(transfer); transfer = -1;
    if (phase == 1) { assert(length == 0); mark("delete-received"); return; }
    char expected[8192]; assert(snprintf(expected, sizeof expected, "file://%s/source%%20%%23%%25.txt\r\n", root) < (int)sizeof expected);
    assert(length == strlen(expected) && !memcmp(bytes, expected, length));
    char p[4096]; path(p, "source #%.txt"); FILE *in = fopen(p, "rb"); assert(in);
    path(p, "received"); FILE *out = fopen(p, "wb"); assert(out);
    size_t n; while ((n = fread(bytes, 1, sizeof bytes, in))) assert(fwrite(bytes, 1, n, out) == n);
    assert(!ferror(in)); assert(fclose(in) == 0); assert(fclose(out) == 0);
    wl_data_offer_finish(offer); wl_display_flush(display);
}
int main(int argc, char **argv) {
    assert(argc == 2); root = argv[1]; display = wl_display_connect(NULL); assert(display);
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL); assert(wl_display_roundtrip(display) >= 0);
    assert(compositor && shm && seat && manager && wm);
    struct wl_data_device *device = wl_data_device_manager_get_data_device(manager, seat);
    wl_data_device_add_listener(device, &device_listener, NULL);
    char p[4096]; path(p, "buffer-XXXXXX"); int fd = mkstemp(p); assert(fd >= 0); unlink(p);
    const int size = 800 * 600 * 4; assert(ftruncate(fd, size) == 0);
    void *pixels = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0); assert(pixels != MAP_FAILED);
    memset(pixels, 0x55, size);
    struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, size);
    buffer = wl_shm_pool_create_buffer(pool, 0, 800, 600, 800 * 4, WL_SHM_FORMAT_XRGB8888);
    wl_shm_pool_destroy(pool); close(fd); munmap(pixels, size);
    surface = wl_compositor_create_surface(compositor);
    struct xdg_surface *xdg = xdg_wm_base_get_xdg_surface(wm, surface);
    xdg_surface_add_listener(xdg, &surface_listener, NULL);
    struct xdg_toplevel *toplevel = xdg_surface_get_toplevel(xdg);
    xdg_toplevel_set_app_id(toplevel, "com.ftpeach.WaylandDragReceiver");
    xdg_toplevel_set_fullscreen(toplevel, NULL); wl_surface_commit(surface);
    for (;;) {
        while (wl_display_prepare_read(display) != 0) assert(wl_display_dispatch_pending(display) >= 0);
        assert(wl_display_flush(display) >= 0 || errno == EAGAIN);
        struct pollfd fds[2] = {{wl_display_get_fd(display), POLLIN, 0}, {transfer, POLLIN, 0}};
        int ready; do { ready = poll(fds, 2, -1); } while (ready < 0 && errno == EINTR); assert(ready >= 0);
        if (fds[0].revents) assert(wl_display_read_events(display) >= 0); else wl_display_cancel_read(display);
        if (fds[1].revents) {
            ssize_t n = read(transfer, bytes + length, sizeof bytes - length);
            if (n == 0) completed();
            else if (n > 0) { length += n; assert(length < sizeof bytes); }
            else assert(errno == EAGAIN || errno == EINTR);
        }
        assert(wl_display_dispatch_pending(display) >= 0);
    }
}
"#;

#[test]
fn copy_drag_answers_eager_delete_on_wayland() {
    let Some(root) = std::env::var_os("FTPEACH_WAYLAND_DRAG_ROOT") else {
        let output = Command::new("xvfb-run")
            .args([
                "-a",
                "-s",
                "-screen 0 800x600x24",
                "/usr/bin/python3",
                "-c",
                LAUNCHER,
            ])
            .arg(std::env::current_exe().unwrap())
            .arg(TEST)
            .arg(RECEIVER)
            .output()
            .expect("Wayland drag regression requires Xvfb, Weston and Python GTK3");
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    };
    let root = std::path::PathBuf::from(root);
    gtk::init().unwrap();
    let app = gtk::Application::new(
        Some("com.ftpeach.WaylandDragSource"),
        gio::ApplicationFlags::NON_UNIQUE,
    );
    app.register(None::<&gio::Cancellable>).unwrap();
    let source = gtk::ApplicationWindow::new(&app);
    assert_eq!(source.display().type_().name(), "GdkWaylandDisplay");
    let expected = b"copy-only Wayland selection remains readable after DELETE\n";
    let original = root.join("source #%.txt");
    fs::write(&original, expected).unwrap();
    let data = uri_list(&[original.to_string_lossy().into_owned()]).unwrap();
    let deletes = Rc::new(Cell::new(0));
    let observed_deletes = deletes.clone();
    source.connect_drag_data_delete(move |_, _| observed_deletes.set(observed_deletes.get() + 1));
    let ended = Rc::new(Cell::new(false));
    let observed_end = ended.clone();
    source.connect_drag_end(move |_, _| observed_end.set(true));
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    let tx = RefCell::new(Some(tx));
    let receiver = Rc::new(RefCell::new(None::<std::process::Child>));
    let started_receiver = receiver.clone();
    let receiver_root = root.clone();
    source.add_events(gdk::EventMask::BUTTON_PRESS_MASK);
    source.connect_button_press_event(move |widget, event| {
        PRESS.with(|press| *press.borrow_mut() = Some(std::ops::Deref::deref(event).clone()));
        if let Some(tx) = tx.borrow_mut().take() {
            let widget = widget.clone();
            let data = data.clone();
            let root = receiver_root.clone();
            let receiver = started_receiver.clone();
            glib::idle_add_local_once(move || {
                begin(&widget, data, tx, |_, _| {});
                *receiver.borrow_mut() = Some(
                    Command::new(std::env::var_os("FTPEACH_WAYLAND_DRAG_RECEIVER").unwrap())
                        .arg(root)
                        .spawn()
                        .unwrap(),
                );
            });
        }
        glib::Propagation::Proceed
    });
    let ready_root = root.clone();
    source.connect_map_event(move |_, _| {
        fs::write(ready_root.join("source-ready"), []).unwrap();
        glib::Propagation::Proceed
    });
    source.fullscreen();
    source.show_all();
    let deadline = Instant::now() + Duration::from_secs(12);
    while !(ended.get() && root.join("received").exists()) && Instant::now() < deadline {
        glib::MainContext::default().iteration(false);
        std::thread::sleep(Duration::from_millis(1));
    }
    if let Some(mut receiver) = receiver.borrow_mut().take() {
        let _ = receiver.kill();
        receiver.wait().unwrap();
    }
    source.close();
    assert_eq!(
        deletes.get(),
        1,
        "The actual source DELETE handler was not exercised exactly once"
    );
    assert!(
        root.join("delete-received").exists(),
        "Eager DELETE blocked before drop"
    );
    assert!(ended.get(), "Wayland drag did not end");
    rx.try_recv().expect("Native drag did not resolve").unwrap();
    assert_eq!(fs::read(root.join("received")).unwrap(), expected);
    assert_eq!(
        fs::read(original).unwrap(),
        expected,
        "COPY deleted or changed its source"
    );
}
