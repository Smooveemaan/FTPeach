# suppaftp 11.0.0, patched for FTPeach

This is the published `suppaftp` 11.0.0 source (MIT OR Apache-2.0, see
`Cargo.toml` and https://github.com/veeso/suppaftp), used through
`[patch.crates-io]` in `src-tauri/Cargo.toml` and the standalone
`src-tauri/fuzz/Cargo.toml`. Keep both workspaces on this source so parser
regressions and fuzzing exercise the shipped reader. Only the tokio async client is
patched; every change is marked with a `FTPeach patch:` comment.

1. **Bounded control replies** (`src/types.rs`, `src/async_ftp/tokio_ftp.rs`).
   `read_line` read a line with `read_until` and no limit, and a multiline
   reply accumulated until its terminal line, so a server -- including one
   answering the greeting, before any authentication -- could make the client
   buffer without bound. Replies now obey `ReplyLimits` (8 KiB per line,
   256 KiB and 4096 lines per reply, adjustable with `set_reply_limits` or
   `connect_with_stream_limited`). Crossing a limit returns
   `FtpError::ConnectionError` holding `ReplyTooLarge`, which FTPeach reports
   as `resourceLimit`; the connection is not usable afterwards. `feat`, which
   reads its continuation lines itself, counts them the same way.

2. **Active-mode data connections from the server only**
   (`src/async_ftp/tokio_ftp.rs`, `data_command`). The listener the client
   opens for `PORT`/`EPRT` accepted whichever connection arrived first and
   only logged its address. It now accepts the control connection's peer,
   or the address given to `set_active_peer` -- FTPeach needs that when its
   encoding relay makes the control peer a loopback address -- and ignores
   the others until the active timeout. This protects against another local
   program answering first; it is not protection against a network attacker
   who can also intercept the control connection.

`rustfmt.toml` here turns formatting off so `cargo fmt --all` leaves this
copy alone and the patch stays a small diff against the published crate.

To move to a newer suppaftp: extract the new version next to this file,
re-apply the two changes above (search for `FTPeach patch:`), and run
`npm run rust:test` -- `protocol::ftp::protocol_tests::local_integration_tests`
covers both.
