# FTPeach architecture

The React renderer owns presentation and user intent. The application layer owns recursive file-operation orchestration. Privileged operations pass through `src/platform/api/*` and narrowly scoped Tauri commands. Rust validates IPC and owns connections, files, settings, and secrets. Protocol backends implement the common `ProtocolBackend` interface.

```text
React UI -> feature hooks -> platform API -> Tauri commands
                                      -> Sessions -> browse ProtocolBackend
                                                  -> TransferPool -> workers
                                      -> Store / Vault / filesystem
```

## Backend ownership

| Location | Responsibility |
| --- | --- |
| `lib.rs` | Compose plugins, managed state and the IPC command registry. |
| `runtime/startup.rs` | Initialize emitters, tray and window event wiring after state registration. |
| `commands/` | Validate IPC input, authorize calls and translate service results. |
| `application/` | Coordinate connection and file-transfer use cases. |
| `application/recursive_transfer/` | Own recursive scan, copy, verification, cancellation and source removal. |
| `session.rs` | Own stable connection slots and access to their transfer pools. |
| `protocol/` | Implement wire protocols, remote entry parsing and protocol capabilities. |
| `transfer/` | Schedule workers, relay bytes, pace traffic and deliver progress. |
| `local_fs/` | Validate and perform local filesystem and native file actions. |
| `store/` | Persist sites, settings, tabs and known hosts. |
| `security/` | Protect secrets and enforce authorization and connection policy. |
| `domain/`, `ipc.rs` | Define shared data and wire contracts respectively. |

Recursive transfers expose only `Endpoint`, `Intent`, `Report`, `run` and `cancel`.
Their `io`, `manifest`, `model` and `scan` modules are private; Rust visibility enforces
this boundary. Tests live with their owner: recursive cases in
`application/recursive_transfer/tests.rs`, staged upload and relay cases in
`application/transfer_service_tests.rs`.

Startup constructs one `Store` and derives the vault directory from it. Progress updates
replace the pending message in place, retaining its map key and scheduled timer. FTP permission
normalization writes directly into one nine-byte string, without temporary vectors or strings.

## Browse session lifecycle

`Sessions` keeps a stable slot for every `connectionId`. A slot mutex serializes connect, list, mkdir, rename, remove, and disconnect operations for one connection, while different IDs operate concurrently. Connect has a separate cancellation token, allowing disconnect to cancel a stalled connection without waiting for the slot lock.

A successful session contains one `browse_client`, a browse-command timeout, and a `TransferPool`. Reconnecting destroys the old session. Shutdown first stops the pool and waits for transfer tasks, then closes the browse client.

`application/session_service.rs` owns the pipeline: resolving a site's stored configuration,
opening the browse client, sizing and building its transfer pool, and tearing the session down.
`commands/session/connection.rs` translates -- it validates the incoming config and shapes the
service's outcome into the response the renderer expects. `commands/session/browse.rs` owns
listing and remote filesystem mutations. All browse mutations, including delete, share the same
timeout/cancellation teardown pipeline; frontend-facing command names stay unchanged.

## Renderer composition root

`app/Application.tsx` composes feature hooks and view models; it does not own reusable domain
logic. Cross-feature shell behavior lives in `app/useApplicationController.ts`: user-facing error
normalization, vault-unlock recovery, global command bindings, and small derived presentation
states. Feature-specific behavior remains in its feature directory, while `Workspace` and
`AppDialogs` remain presentation boundaries.

## Transfer pool

Each worker is a separate authenticated `ProtocolBackend`. A fixed pool limits connections according to the configured value; an unlimited pool grows only to the number of waiting tasks. Transfer tasks never borrow the browse client, so uploads do not block navigation.

Tasks wait in a FIFO queue. Canceling a queued task removes it; an active task receives a `CancellationToken`, while non-interruptible I/O is stopped by disconnecting its worker. Lost workers are replaced. Destroying the pool rejects new tasks and closes workers. Server-to-server copies reserve workers from the source and target pools and relay bytes through a bounded in-memory pipe; relay transfers do not support resume.

Protocol backends share `protocol::backend_logger::BackendLogger` for enablement, sink ownership,
thread-safe emission, and structured events. FTP, SFTP, and WebDAV keep wire-level formatting in
their own modules while relying on the shared component for logging lifecycle state.

WebDAV connection and file-operation orchestration stays in `protocol/webdav.rs`. Parsing of
PROPFIND responses, href normalization, HTTP dates, and resumed-response range validation lives in
`protocol/webdav/response.rs`; this keeps untrusted response interpretation independently
reviewable without widening the protocol module's public API.

## Data and invariants

The store serializes JSON writes and uses a temporary sibling followed by an atomic replacement. The renderer receives only non-secret site records; the backend resolves secrets by `siteId` through DPAPI or Stronghold. See [`storage.md`](storage.md) and [`security.md`](security.md).

Rust unit tests that need private implementation details live in adjacent test modules rather than
inside production files: `store/tests.rs` covers the store facade, while
`commands/app_settings_transfer_tests.rs` covers settings import/export. FTP, SFTP, WebDAV, proxy
handshakes, sensitive-operation authorization, and vault persistence each keep their suites in an
adjacent `*_tests.rs` file. They remain child modules, so moving them does not weaken their coverage
or force production internals to become public.

The Rust composition root is grouped by responsibility: `security/` owns vault and authorization,
`transfer/` owns pooling, relay, progress, and throttling, `local_fs/` owns validated local-file
operations, and `runtime/` owns process/window lifecycle and diagnostics. Every path spells its
zone out — `crate::security::vault`, `crate::runtime::shutdown`, `crate::local_fs::preview` — so
the grouping is readable at each import and checkable by
`scripts/checks/check-rust-boundaries.ts`, which rejects a crate path whose first segment is not a module
`lib.rs` declares. Smoke-test JavaScript is an application
asset in `src-tauri/assets/`, not Rust source.

`run()` is wiring only. Deciding what a window close means — hide to tray, or shut down — lives in
`runtime::shutdown::on_close_requested`, and bringing the process in line with the saved settings
at startup lives in `runtime::settings_apply::apply_at_startup`, beside the same functions the
settings-save and settings-import paths call.

## Wire and vocabulary

`ipc.rs` is the wire and nothing else: `ErrorCode`, `CommandError`, `CommandResult`, and the
`OkResult` envelope, with the test that pins every code's camelCase spelling. What a connection,
a saved site or a settings blob *is* lives in `domain/` — `domain/connection.rs`,
`domain/site.rs`, `domain/settings.rs`.

Persistence and protocols import `domain` for shared data types.

They import `ipc` for `CommandError` and `ErrorCode`, and that is deliberate: the failure
vocabulary is one shared type family with a pinned wire contract, and giving persistence a second
error type to be translated at every boundary would cost more than the coupling it removes.

## Narrow dependencies

`SftpBackend::new` takes an `Arc<dyn KnownHostsStore>`, not a `Store`. The backend performs one
persistence operation — pinning or verifying a host key on first sight — and
`protocol/known_hosts.rs` declares exactly that; `store/known_hosts.rs` implements it. The interface restricts the backend to host-key persistence.

Remote path validation and authorization live in `security/`: `security/connection_guard.rs` for remote paths
and `security/sensitive.rs` for authorization, beside `local_fs/filesystem_safety.rs`'s local-path
guard, which stays with the local filesystem it guards.

## Crate zone direction

`application/`, `store/`, `protocol/`, `security/`, `transfer/`, and `local_fs/` sit below the Tauri command
layer: `commands/` calls them, never the reverse. Naming `crate::commands::…` from one of those
zones closes a cycle, so `scripts/checks/check-rust-boundaries.ts` rejects it and `npm run check` runs
the script. The same script rejects one `commands/` module naming another, and reports any import
cycle between crate modules however long the path.

Command modules do not see each other, so anything two of them need lives with its owner:
`pool_for` is a method on `Sessions`, `NO_SESSION` sits with the response envelopes in `ipc`,
`LogState` with the emitter in `runtime`, `classify_transfer_error` in `transfer`,
`DragOutFile` in `native_drag`, and `apply_speed_limit`/`apply_prevent_sleep`/
`apply_log_date_format` in `runtime/settings_apply.rs`.

Two consequences of that rule are visible in the tree. The `OkResult`/`ok`/`err` envelope that
local delete and the command layer both produce lives in `ipc.rs` with the other wire types, not
in `commands/fs.rs`. And the `sensitive` plugin's handler list — which commands sit behind an
authorization prompt — lives in `runtime/sensitive_plugin.rs`, because choosing the gated commands
is process wiring; `security/sensitive.rs` keeps the authorization rules themselves.

Saved-site persistence is split by lifecycle rather than file size. `store/sites/queries.rs` owns
listing, connection configuration, secret resolution, and migrations;
`store/sites/mutations.rs` owns site/folder CRUD and layout updates. `store/sites.rs` retains shared
validation and module boundaries, while the public `Store` API remains unchanged.

General application commands stay in `commands/app.rs`. Settings import/export has its own
`commands/app_settings_transfer.rs` module because it owns a separate validation, redaction,
native-dialog, persistence, and rollback workflow.

- the frontend does not call `invoke` outside the platform boundary;
- transfer code does not hold a browse-session lock during a transfer;
- remote names are validated before a local path is constructed;
- new capabilities, secrets, and destructive operations require a security review.

## Executable safety contracts

[File operation safety](transfer-safety.md) records Windows drive/UNC identity, protected-path scope, operation-owned artifacts, overwrite, resume and cancellation policies. [Regression coverage](regression-coverage.md) links each A01–A18 contract to its permanent suite. [P2 resilience](p2-resilience.md) describes the backend recursive coordinator, manifest budgets and storage recovery.

Closed pools reject admission; replacement failure settles queued callers, and paired relay admission never holds a worker while waiting for another pool. These are exercised in transfer_pool.rs by replacement_failure_finishes_all_waiters_and_rejects_new_work, same_pool_single_worker_relay_fails_without_starting_either_leg and opposite_relays_and_cancellation_release_both_workers.

Zero concurrency means unlimited demand-driven workers; zero connect timeout is valid and uses a 60-second transfer idle default. Zero speed limit disables pacing. A known file length of zero means empty; missing metadata stays None, and relay skips only the unavailable size comparison. See settings schema tests, rate_limiter tests, transfer_file::tests::known_zero_is_not_unknown and relay tests. Metadata agreement is not a content hash.

Protocol capabilities differ: FTP final replacement needs explicit permission because portable no-replace rename is unavailable; SFTP uses v3 RENAME; WebDAV uses Overwrite: F for no-replace. Unknown-length WebDAV uploads stream without a buffered fallback. WebDAV remote-to-local directory move is refused because recursive DELETE cannot preserve newly appearing children. These contracts and residual alias/race risks require real server validation before release.

## Comment conventions

Use English. Rust module docs describe responsibility and invariants; API docs describe contracts, side effects and limitations; inline comments explain non-obvious reasons and ordering. Preserve unsafe justifications, cancellation, ownership, security checks and protocol quirks. Avoid restating code or embedding refactoring history in current contracts; historical decisions belong in change history or ADRs.
