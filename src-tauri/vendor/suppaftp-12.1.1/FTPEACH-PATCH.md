# suppaftp 12.1.1, patched for FTPeach

This is the published `suppaftp` 12.1.1 source (MIT OR Apache-2.0, see
https://github.com/veeso/suppaftp), used through `[patch.crates-io]` in
`src-tauri/Cargo.toml`. Every change is marked with a `FTPeach patch:` comment.

1. **A command is flushed after it is written** (`src/async_ftp/tokio_ftp/control.rs`
   and `src/async_ftp/smol_ftp/control.rs`, `ControlChannel::perform`).
   `perform` wrote the command with `write_all` and went on to read the reply.
   A TLS stream such as tokio-rustls accepts the bytes into its record buffer
   even when the socket is not ready for them, and reading never sends that
   buffer, so the command could stay in the client while both sides waited
   for each other. Against IIS FTPS this showed as `PBSZ` answered and `PROT P`
   never arriving, until the server closed the connection. `perform` now
   flushes after writing. `flush_tests` in the tokio `control.rs` covers it
   with a stream that holds bytes until a flush.

2. **Active mode listens on the control connection's address**
   (`src/async_ftp/tokio_ftp.rs`, `src/async_ftp/smol_ftp.rs`, `src/sync_ftp.rs`,
   `active`). The data listener was bound to `0.0.0.0`, every interface,
   although `PORT` names only the control connection's address. Each test
   binary that used active mode against a local server made Windows ask about
   the firewall, and that prompt dimmed the screen for the native tests. The
   listener is now bound to the address `PORT` sends, as upstream does since
   12.2.1 (#198). `should_listen_for_active_data_on_the_control_address` in
   the tokio `tokio_ftp.rs` covers it.

The fuzz crate keeps the published 12.1.1: it parses replies and sends nothing.
Drop this copy once a released suppaftp flushes its commands; 12.2.1 has the
second change but not the first, and sends REST only with its own transfer
commands, which FTPeach's own RETR would have to follow first.
