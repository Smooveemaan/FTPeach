# FTPeach architecture

FTPeach is a Windows desktop file manager for local folders and FTP, FTPS,
SFTP and WebDAV servers. It is a Tauri 2 application: a React/TypeScript
renderer draws the interface and expresses what the user wants, and a Rust
backend owns everything with consequences — connections, files, settings,
secrets and the operating system.

This page describes the structure that stays stable. Rules for where frontend
code goes are in [frontend architecture](frontend-architecture.md); behavior
guarantees are in [transfer safety](transfer-safety.md),
[storage](storage.md) and [security](security.md).

## Processes and windows

```text
┌────────────── WebView2: main window ──────────────┐   ┌─ WebView2: confirmation ─┐
│ React renderer (src/)                             │   │ same bundle, loaded with │
│   app/ ── features/* ── platform/api ── invoke ───┼─┐ │ ?security-confirmation=  │
└───────────────────────────────────────────────────┘ │ │ narrow capability only   │
                                                      │ └────────────┬─────────────┘
                     Tauri IPC: commands + events     │              │
┌──────────────────────── Rust process (src-tauri/src) ┴──────────────┴─────────────┐
│ commands/ ─ application/ ─ session.rs ─ transfer/ ─ protocol/ ── network          │
│            local_fs/ ─ store/ ─ security/ ─ runtime/ (tray, window, updater, log) │
└───────────────────────────────────────────────────────────────────────────────────┘
```

- **Main window.** The whole interface. It is treated as untrusted input: a
  compromised renderer must not be able to read secrets, delete files or trust
  a host key without the user seeing a native confirmation.
- **Confirmation window.** A second window the backend opens for sensitive
  operations. It loads the same bundle, renders only
  `platform/SecurityConfirmation.tsx` and has its own capability file
  (`src-tauri/capabilities/security-confirmation.json`) that allows almost
  nothing.
- **Backend.** One process, one Tokio runtime. Global state is registered in
  `lib.rs` with `.manage(...)`; `runtime/startup.rs` wires the tray, window
  events and emitters after that.

## Frontend ownership

`src/main.tsx` installs the IPC adapter and mounts `app/Application.tsx`, the
composition root. Code is grouped by what the user would name:

| Area | Owns |
| --- | --- |
| `app/` | The shell: title bar, menus, dialogs, status bar, tray bridge, layout. Composes features; nothing imports it. |
| `features/file-browser/` | Tabs, panes, navigation, selection, clipboard, local and remote file operations. |
| `features/transfers/` | The transfer queue: rows, lifecycle, overwrite approval, routing of copies, moves and OS drops. |
| `features/sites/` | Saved sites and local paths, the site manager, its tree and drag and drop. |
| `features/settings/` | Settings state and the settings dialog, including vault settings. |
| `features/logs/`, `open-with/`, `connections/`, `updater/` | Their own workflows. |
| `platform/` | The only code that talks to Tauri: `tauriApi.ts` (invoke and events) and typed wrappers in `platform/api/`. |
| `components/`, `hooks/`, `shared/`, `shortcuts/`, `i18n/` | Reusable UI, UI mechanics and plain functions. They never import a feature. |

State lives with its owner and flows down as props; there is no global store
and no React context. Two deliberate exceptions keep hot paths cheap: the
transfer queue is a module-level store read with `useSyncExternalStore`
(`features/transfers/transferStore.ts`), sized for 100,000 rows, and the
async-failure sink in `shared/asyncFailure.ts`.

Logic that must be testable without React is written as plain factories that
take their collaborators as arguments (`features/file-browser/panes/create*.ts`,
`features/transfers/createTransferRouting.ts`); hooks wrap them. A feature's
public API is its `index.ts`, plus `ui.ts` for components, so Node tests can
import the headless part without JSX. `npm run lint` enforces the import rules.

## Backend ownership

| Zone | Owns |
| --- | --- |
| `lib.rs` | Plugins, managed state and the command registry. Wiring only. |
| `commands/` | Tauri commands: deserialize arguments, authorize, call a service, shape the response. No business rules. |
| `application/` | Use cases that span zones: opening and closing sessions (`session_service`), single transfers (`transfer_service`), resumable uploads, and recursive copy/move (`recursive_transfer/`). |
| `session.rs` | `Sessions`: one slot per renderer-chosen `connectionId`, holding the browse connection and that connection's transfer pool. |
| `protocol/` | The `ProtocolBackend` trait, its FTP, SFTP and WebDAV drivers, listing parsers, the TCP/proxy transport, and the typed per-protocol connection config. |
| `transfer/` | Worker pools, server-to-server relay, progress events, rate and concurrency limits, upload staging. |
| `local_fs/` | Every operation on the user's own disk: listing, create, rename, delete, recycle bin, staged copy, verified move, reservations, open-with copies. |
| `store/` | JSON persistence in `%APPDATA%\FTPeach` and secret-field placement. |
| `security/` | Vault, DPAPI, Windows Hello unlock, sensitive-operation grants, path and name guards, redaction. |
| `runtime/` | Process lifecycle: startup, shutdown, tray, window geometry and scale, logging, updater staging, auto-lock. |
| `native_drag/` | Dragging remote and local files out to Explorer as OLE virtual files. |
| `domain/`, `ipc.rs` | Shared data types, and the IPC wire types (`ErrorCode`, `CommandError`). |

Dependencies point down: `commands` calls the zones below it and nothing
calls `commands` except the registry in `lib.rs` and
`runtime/sensitive_plugin.rs`. Command modules do not import each other;
anything two of them need lives with its owner. `npm run check:rust-boundaries`
enforces the table of allowed edges in `scripts/checks/check-rust-boundaries.ts`
and rejects cycles.

## IPC

The renderer reaches the backend only through `src/platform`. Features import
`api` from `platform/api/index.ts`; each namespace (`api.session`,
`api.transfer`, `api.fsLocal`, `api.sites`, `api.settings`, `api.vault`, …)
wraps a group of commands, checks every response shape at runtime and returns
typed values. Nothing outside `src/platform` imports `@tauri-apps/api`.

**Commands** are named `<area>_<verb>` (`session_connect`, `transfer_upload`,
`fs_delete`) and take camelCase arguments. Every command is listed in
`lib.rs` or, when it needs a grant, in `runtime/sensitive_plugin.rs`, and in
the capability files; `npm run check:command-acl` fails when the lists
disagree. Adding a command means: the function in `commands/<area>.rs`, its
registration, its capability entry, and a wrapper in `platform/api/`.

**Events** carry what the backend starts on its own:

| Event | Payload |
| --- | --- |
| `transfer:progress` | Batched progress, completion and failure for transfers. |
| `transfer:dragOutStarted` | A download Explorer began pulling during a drag-out. |
| `protocol:log` | Batches of protocol log lines. |
| `preview:progress`, `openWith:changed` | Open-with downloads and edited copies. |
| `vault:locked` | The vault locked, with the reason. |
| `updater:status`, `tray:action` | Updater state; tray menu clicks. |

**Sensitive commands** (delete, reveal a secret, trust a host key, execute a
file, relax protection, import/export settings, …) are served by the
`sensitive` plugin. The renderer first asks `authorize_sensitive` for a grant;
the backend derives the exact target from the request, shows the
confirmation window when the operation needs one, and returns a one-time
token bound to the window, the operation, that target and the vault session.
The command then consumes the token against the target it computes itself.
The renderer never states what it is authorized to do; it can only ask.

### Command failures

A command returns `CommandResult<T>` (`Result<T, CommandError>`) and fails
by returning `Err`: the promise rejects with `{ code, message, details? }`.
A command that can do nothing but succeed returns `T` directly.

- `code` is an `ErrorCode` from the closed camelCase list in `ipc.rs`.
  `COMMAND_ERROR_CODES` in `platform/ipcContracts.ts` is the renderer's
  copy, and `test/unit/platform/errorCodeParity.test.ts` fails when the two
  differ.
- `message` is English fallback text. `details` is the error chain, for
  diagnostics; it never carries a password, passphrase, proxy password or
  grant token.
- A call that can end in more than one successful state says which in `T`.
  `session_connect` answers `{ outcome: "connected" }` or
  `{ outcome: "hostKeyUnconfirmed", host, port, expected?, actual }`, because a
  host key the user has to confirm is a decision, not a failure; a save
  answers whether the password could be stored; a file dialog answers when it
  was cancelled.
- A failure the backend understands is created typed, with
  `protocol::fail(code, message)` or `CommandError::new`.
  `CommandError::from_anyhow` classifies the rest, in order: a typed error in
  the chain, a server reply code, the `io::ErrorKind` or the Windows error
  code std leaves uncategorized, and the error text last. It is the only
  place a code is read from text.

In the renderer, `platform/tauriApi.ts` turns a rejection into a
`{ ok: false, error, errorCode, diagnosticDetails }` value, so the `api`
wrappers never throw, and a wrapper turns a success into `{ ok: true, … }`.
A rejection that is not a `CommandError` (a call Tauri refused before the
command ran) is `internal`. `shared/errorMessages.ts` chooses the text by
code alone.

Only an `internal` failure is logged: `invoke` writes it to the console
with its details, and the console is forwarded to `ftpeach-app.log`, which
redacts what it writes. Every other code is an answer the caller shows where
it happened, and would only fill the log.

## Connection lifecycle

A pane connects with `session_connect(connectionId, request, settings)`. The
`connectionId` is minted by the renderer per pane and connection attempt; the
backend caps the number of slots. Every step works with typed values:

| Step | What happens | Secrets |
| --- | --- | --- |
| 1. Renderer (`features/file-browser/panes/createPaneSessionLifecycle.ts`) | Sends a `ConnectRequest`: a saved site by its id, or a typed-in server as `ServerSettings` with its credentials. Sends the timeout and FTP mode apart, as `WindowConnectionSettings`, because the settings dialog applies them to new connections while it previews them. | A typed password or passphrase for a typed-in server. A saved site's never. |
| 2. IPC edge (`commands/session/connection.rs`) | Resolves the server and credentials (step 3), then refuses a key or CA file on a share the user never chose. | Passed on. |
| 3. Saved site (`application/session_service.rs`, `store/sites`) | For a saved site, `Store::saved_server` reads its record from `sites.json` into `ServerSettings`, protecting a plaintext secret left in the file first. | Read here from DPAPI or the vault into `Credentials`. |
| 4. Connection defaults (`store/settings.rs`) | `Store::connection_defaults` adds the saved proxy and host-key policy to the window's timeout and FTP mode. | The proxy password. |
| 5. Protocol config (`protocol/config.rs`) | `ConnectionConfig::build` makes the per-protocol configuration from the server, the credentials and the defaults, and holds every check a connect makes. | `SensitiveString`, zeroized on drop. |
| 6. `ProtocolBackend::connect` | Opens the browse connection. | Used and dropped. |

`ServerSettings` (`domain/connection.rs`) is what a saved site stores about its
server and what a typed-in connect sends. Its one reader accepts every form an
earlier version stored, such as numeric strings and FTPS written as `ftp` with
`secure: true`, and its writer produces what `sites.json` keeps and
`sites_list` returns. The credential scope that decides when a saved password
needs confirming to move reads a bookmark through it too.

On success `application/session_service.rs` builds a `TransferPool` whose
factory opens further backends from the same `ConnectionConfig`, and stores
both in the slot. The slot's async mutex serializes browse operations for one
connection (list, mkdir, rename, delete, disconnect); different connections
run in parallel. Transfers never take the browse lock. A connect has its own
cancellation token, so a disconnect can abandon a stalled connect without
waiting for the lock. Teardown stops the pool, waits for its tasks, removes
staging files that can no longer be resumed, then closes the browse
connection, all under a deadline.

**Adding a connection property.** A property of one server is a field of
`ServerSettings`, read in `from_json`, written in `to_json` and named in `KEYS`
(which the import allowlist uses), mirrored in `shared/siteContracts.ts`, and
used in `ConnectionConfig::build`. What a bookmark may store is checked by
`validate_site_input` in `store/sites.rs`. A property that applies to every
connection is a setting in `src/shared/settingsDefaults.json`, read by
`Store::connection_defaults`.

## Protocol abstraction

`protocol::ProtocolBackend` is the only interface the rest of the backend
uses for a server: connect, list, mkdir, create, remove, rename, chmod, size,
ranged read, upload/download to a path, and streaming to or from a
reader/writer. Methods a protocol cannot perform safely have default
implementations that refuse (`rename_no_replace`, `read_range`,
`remove_empty_directory`), so a new protocol fails closed until it proves
otherwise. Backends are `Box<dyn ProtocolBackend>`, which is why the trait
uses `async_trait`.

Drivers return `anyhow::Result`: most failures are whatever the protocol crate
reported, and the driver adds context. Failures the driver itself decides on
carry a typed `CommandError` inside the `anyhow::Error`.

Each driver is one module with the workarounds its servers need, documented
at the code that needs them: `ftp.rs` (with `ftp_charset.rs` for non-UTF-8
servers and `list_parse.rs` for LIST formats), `sftp.rs` (host keys through
the narrow `protocol::known_hosts::KnownHostsStore` trait), `webdav.rs` (with
`webdav/response.rs` for PROPFIND parsing). FTP and SFTP open every TCP
connection through `transport.rs`, which applies the proxy: SOCKS4/4a, SOCKS5
and HTTP CONNECT handshakes are written by hand in `proxy.rs` so no byte of
the server's greeting is lost. WebDAV uses reqwest; `socks_bridge.rs` exists
only to work around a SOCKS4 bug in reqwest's dependency and names the
upstream fix that will retire it.

FTPeach carries patched copies of `suppaftp` and `wry` in `src-tauri/vendor/`;
each has a `FTPEACH-PATCH.md` listing its changes.

## Transfers

A transfer runs on a worker from the connection's `TransferPool`, never on the
browse connection. Workers are separate authenticated backends. A pool grows
with demand, up to the site's connection limit minus the browse connection; a
process-wide limiter applies the global concurrency setting, and a
process-wide rate limiter applies the speed limit. Queued tasks can be
cancelled; running ones get a `CancellationToken`, and I/O that cannot be
interrupted is stopped by dropping its worker, which the pool replaces.

- **Single files** (`application/transfer_service.rs`): uploads go to a
  hidden staging name and are renamed into place; downloads write a partial
  file with a resume record that proves it belongs to the same source.
  Replacing an existing file is explicit, and protocols without an atomic
  no-replace rename refuse rather than guess.
- **Server to server**: the bytes are relayed through this computer over a
  bounded in-memory pipe between a worker of each pool; relays do not resume.
- **Folders** (`application/recursive_transfer/`): the renderer sends one
  intent; the backend scans, reserves, copies, verifies and, for a move,
  deletes the source only after everything landed unchanged. Its public
  surface is `Endpoint`, `Intent`, `Report`, `run` and `cancel`.
- **Progress** reaches the renderer as batched `transfer:progress` events.

In the renderer, `features/transfers/` keeps one row per transfer in the
external store, owns retry, pause and cancel, and asks for overwrite
decisions before a transfer starts. [Transfer safety](transfer-safety.md) and
[resilience](p2-resilience.md) list the guarantees and limits.

## Persistence

`store::Store` owns `%APPDATA%\FTPeach`:

| File | Content |
| --- | --- |
| `settings.json` | Settings; the proxy password only as a DPAPI blob or a vault flag. |
| `sites.json`, `local-paths.json` | Saved sites and folders; saved local paths. Secrets as DPAPI blobs or vault flags. |
| `tabs.json` | Restored tabs and panes. No connection state, listings or secrets. |
| `known_hosts.json` | Pinned SSH host-key fingerprints. |
| `trusted_applications.json` | Applications the user allowed for "Open with". |
| `vault.json` + snapshot | The Stronghold vault under enhanced protection. |

Writes go through `store/storage.rs`: one lock per file, a temporary sibling,
then an atomic replace. Reads are tolerant: a record written by any earlier
version must still load, and unknown or missing fields fall back to defaults
rather than failing. `src/shared/settingsDefaults.json` is the single source
of setting names, types and defaults for both sides. [Storage](storage.md)
has the details.

## Security boundaries

- **Secrets never reach the renderer** unless the user reveals one through a
  grant. Site records sent to the renderer carry `hasPassword` flags only.
  In Rust, secrets are `SensitiveString`, which redacts itself in `Debug` and
  zeroizes on drop.
- **Every renderer argument is untrusted.** Remote names are checked as
  single path segments before any local path is built; remote paths are
  refused if they carry CR/LF; local paths are canonicalized and checked
  against protected locations; a name Windows would not store as given (a
  device, a stream separator, a trailing dot) is refused before a file is
  created, by `local_fs::windows_names`, and the renderer repeats that check
  only to keep a doomed download out of the queue.
- **Destructive and revealing operations need a grant** (see IPC above).
- **Text written to disk or exported is redacted**: `security::redaction`
  cleans the protocol log, the application log, saved logs and the
  diagnostic bundle.

[Security design](security.md) and [IPC permissions](ipc-permissions.md)
cover the threat model and the capability files.

## Error flow

```text
protocol crate / io / OS ──► driver adds context, or fail(code, …) ──► anyhow::Error
      ──► CommandError::from_anyhow (typed error, reply, io kind, text last)
      ──► command returns Err(CommandError)                   [Rust]
─────────────────── IPC rejection { code, message, details } ───────────────────
      ──► platform/tauriApi.ts: rejection → { ok: false, errorCode, … },
          internal ones logged
      ──► shared/errorMessages.ts: code → translated text      [renderer]
```

A transfer that fails reports it in a `transfer:progress` event instead,
classified once by the driver (`ProgressInfo::failed`) and narrowed to the
few categories a transfer row tells apart (`transfer/error_kind.rs`).

## Where things go

| To add | Start in |
| --- | --- |
| A connection property | `domain/connection.rs` and `protocol/config.rs` (see above). |
| A protocol | A module implementing `ProtocolBackend`, one arm in `application/session_service.rs::create_backend`, and the `Protocol` enum. |
| A command | `commands/<area>.rs`, its registration and capability, and `platform/api/<area>.ts`. |
| A setting | `settingsDefaults.json`, the settings group in `features/settings/useSettings.ts`, its dialog section. |
| An error code | `ipc::ErrorCode` and its fallback message, `COMMAND_ERROR_CODES` in `platform/ipcContracts.ts`, a translation in `shared/errorMessages.ts`. Add one only when the user is told something different or the renderer acts differently. |
| A UI feature | A directory under `src/features/` with an `index.ts`; wire it in `app/`. |
