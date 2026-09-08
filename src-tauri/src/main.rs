// Without the windows subsystem attribute, every release launch opens an
// extra console window alongside the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    app_lib::run();
}
