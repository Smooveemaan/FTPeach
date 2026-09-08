# Server response fuzzing

These targets compile the production LIST and WebDAV response sources with their
real IPC error type, without building the desktop UI. FTP replies exercise the
same suppaftp Tokio parser as the application via a finite loopback stream.
No external server, credentials or user files are used.

Use Linux (or a Linux container) with the pinned tools:

```sh
rustup toolchain install nightly-2026-09-01 --profile minimal
cargo +nightly-2026-09-01 install cargo-fuzz --version 0.13.2 --locked
cd src-tauri
cargo +nightly-2026-09-01 test --locked --manifest-path fuzz/Cargo.toml --lib
cargo +nightly-2026-09-01 fuzz run list_parse -- -max_total_time=60
cargo +nightly-2026-09-01 fuzz run ftp_response -- -max_total_time=60
cargo +nightly-2026-09-01 fuzz run webdav_propfind -- -max_total_time=60
```

The weekly/manual security workflow runs each target for 60 seconds, limits
inputs to 64 KiB, and saves crashes and evolved corpora for 30 days even on
failure. The job timeout also bounds compilation. Fuzzing is outside the PR
pipeline; SAST runs on PRs.

LIST seeds come from `protocol/list_parse.rs` unit tests; PROPFIND seeds from
`protocol/webdav_tests.rs`; FTP welcome/FEAT replies from `protocol/ftp_tests.rs`,
plus complete and truncated multiline greetings. MLSD examples come from the
locked suppaftp parser tests (the app currently requests LIST).
`malformed-reply` retains an input saved during a local harness timeout; it
replays successfully in isolation. The harness now reuses its loopback listener
to avoid exhausting ephemeral listening ports during sustained fuzzing.

On a crash, download the artifact, reproduce with `cargo fuzz run <target>
<crash-file>`, minimize with `cargo fuzz tmin`, fix the parser, then commit the
minimized input under `corpus/<target>/` with a descriptive regression name.
`cargo test --lib` automatically replays every committed seed and regression.
Do not swallow a panic or delete the input to make CI green. Corpus growth from
routine local fuzzing should be reviewed before committing.

Keep shared parser dependencies aligned with `../Cargo.lock` when upgrading;
commit this workspace's lockfile too. The source modules are included by path,
so parser changes are immediately exercised without copying implementations.
