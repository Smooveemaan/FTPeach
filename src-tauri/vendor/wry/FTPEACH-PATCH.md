# wry 0.55.1, patched for FTPeach

This is the published `wry` 0.55.1 source (MIT OR Apache-2.0, see
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

Drop this copy once a released wry reports the effect itself.
