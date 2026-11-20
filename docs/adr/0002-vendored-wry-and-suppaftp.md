# Vendored dependencies with fixes

FTPeach builds `wry` 0.57.0 from a copy in `src-tauri/vendor/`, with a `FTPEACH-PATCH.md` that lists every change. The `wry` copy reports the copy effect on a drop instead of a move, so Explorer never deletes a file FTPeach failed to copy, stops repeated hovers from flooding the window, and lets the cursor say where a drop is taken. The price is upkeep: a Tauri update that moves to another `wry` drops the patch without a build error, so the copy is checked on every Tauri bump, and goes once an upstream release carries its fixes.

FTPeach previously carried a patched `suppaftp` 12.1.1 copy that flushed each async command after writing it (without which `PROT P` could stall against IIS over FTPS) and bound active mode to the control connection's address; both fixes shipped upstream (in 12.2.1 and 12.2.2/13.0.0), so the vendored copy was removed when updating to `suppaftp` 13.0.0.
