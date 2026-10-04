# wry 0.57.0, patched for FTPeach

This is the published `wry` 0.57.0 source (MIT OR Apache-2.0, see
`LICENSE-MIT`, `LICENSE-APACHE` and https://github.com/tauri-apps/wry), used
through `[patch.crates-io]` in `src-tauri/Cargo.toml`. Every change is marked
with a `FTPeach patch:` comment.

1. **The drop effect reported to the source** (`src/webview2/drag_drop.rs`,
   `Drop`). `DragEnter` and `DragOver` answer `DROPEFFECT_COPY` for a file
   drop, but `Drop` left `pdwEffect` as the source passed it: every effect it
   allowed, `DROPEFFECT_MOVE` included. `DoDragDrop` hands that value back to
   the source, and a source such as Explorer may take a move from it and delete
   its original, even when FTPeach's copy failed. `Drop` now reports the
   hovering effect: copy for files, none otherwise.
2. **A hover is reported only when the pointer moved**
   (`src/webview2/drag_drop.rs`, `DragOver`). While a modifier key is held
   during a drag from Explorer, Windows calls `DragOver` again and again at
   the same point. Each call became a `DragDropEvent::Over` and an event for
   the page, faster than the page handled them, and the window stopped
   responding until the backlog ran out.
3. **The cursor says where a drop is taken** (`src/lib.rs`,
   `src/webview2/mod.rs`, `src/webview2/drag_drop.rs`). `DragOver` answered
   copy everywhere in the window, so Explorer showed a copy cursor over spots
   that take nothing. The new `wry::set_drop_allowed` sets a flag the app
   updates as the pointer moves; `DragOver` and `Drop` answer
   `DROPEFFECT_NONE` while it is off.

Drop this copy once a released wry does all three itself.
