# Duplication

`npm run check:duplicates` runs `scripts/checks/check-duplicates.ts` with the jscpd version
recorded in `package-lock.json` and `scripts/checks/duplication-baseline.json`, at least
60 tokens, once per area, so each area has its own denominator.

| Area | What it measures |
| --- | --- |
| `frontend-ts` | `src/**/*.ts` and `*.tsx` |
| `css` | `src/**/*.css` |
| `rust-production` | `src-tauri/src/**/*.rs` without test files and without any `#[cfg(test)]` item |
| `rust-tests` | `tests.rs`, `*_tests.rs`, `src-tauri/tests/**` and the `#[cfg(test)]` items cut out of production files |

Locale JSON is not measured: translations never repeat as code, and their tens of thousands of lines
made the old single-run percentage meaningless. Adding a language therefore changes no figure.
The share is duplicated lines over non-blank code lines; jscpd's own line count would include the
blank space left where test items were cut out.

The gate is absolute per area: the check fails when duplicated lines exceed
`scripts/checks/duplication-baseline.json`, which also pins the detector version and token
threshold. A change that deliberately adds or removes duplication updates the baseline in the same
commit. CI writes the table to the job summary and keeps `duplication-report/` as an artifact; each
area's `jscpd-report.json` lists the clones with file and line.

Historical measurement of 24 September 2026 (`2a68b2c` plus the upload-outcome and
resume-helper cleanups). The current gate uses `scripts/checks/duplication-baseline.json`,
not the figures below:

| Area | Files | Code lines | Clones | Duplicated lines | Share |
| --- | ---: | ---: | ---: | ---: | ---: |
| frontend-ts | 211 | 31,774 | 6 | 51 | 0.16% |
| css | 23 | 4,667 | 1 | 6 | 0.13% |
| rust-production | 120 | 27,473 | 41 | 395 | 1.44% |
| rust-tests | 90 | 21,784 | 92 | 858 | 3.94% |

## Findings and decisions

Decisions recorded with that historical measurement for groups of at least 20 duplicated
lines and every frontend and CSS clone.

| Where | Lines | Decision |
| --- | ---: | --- |
| `protocol/ftp.rs` ↔ `sftp.rs` ↔ `webdav.rs`, download preparation and completion | 34 | **Removed**: `DownloadTarget` and `LocalDownload` in `protocol/transfer_file.rs` |
| `protocol/ftp.rs` ↔ `sftp.rs` ↔ `webdav.rs`, upload start and completion, connect, listing, create-file, log wrappers, tree removal | 184 | **Partly removed**: an upload's start is `protocol::upload_start` and the backends log through `BackendLogger` directly. **Keep** the rest: upload completion, connect and listing differ in each protocol's guarantees, handshake and reply parsing, and FTP's tree removal lists again past a server's listing cap |
| `commands/fs.rs` with itself, mkdir/create-file reservation and checks | 40 | **Removed**: `local_fs::local_create` owns both operations |
| `commands/fs.rs` with itself, rename and copy prologues | 21 | **Defer**: copy already runs in `local_fs::staged_copy`; rename moves with its own change, since it carries the no-replace guarantee |
| `protocol/ftp.rs` with itself: `upload`/`upload_from_reader`, `download`/`download_to_writer`, rustls `verify_tls12/13_signature` | 63 | **Keep**: file and stream transfer loops differ in their source and resume handling, and rustls requires both verifier methods |
| `commands/session/browse.rs`, validate-and-reserve prologue of mkdir/create/delete | 24 | **Keep**: three lines of prologue per command; the reservation guard has to live in each command's own scope |
| `commands/dialog.rs` ↔ `app_settings_transfer.rs`, native picker boilerplate | 23 | **Removed**: `picked` in `runtime/file_dialog.rs`; the filters and what is approved stay with each picker |
| `sites/SiteSearchResults.tsx` ↔ `SiteTree.tsx`, site context menu | 12 | **Removed**: `siteMenuItems` in `features/sites` |
| `useSettingsTransfer.ts` ↔ `platform/global.d.ts`, import/export result types | 12 | **Removed**: one contract in `platform/api/settings.ts` |
| `useTransferLifecycle.ts` with itself, moving an attempt to queued | 12 | **Removed**: `requeueAttempt` |
| `ToolbarOverflowMenu.tsx` ↔ `PaneSourceSwitcher.tsx`, overlay position | 15 | **Removed**: `placeBelowAnchor` in `hooks/useMenuPosition.ts` |
| `ConnectionSettings.tsx` ↔ `ProxySettings.tsx`, props interface | 13 | **Keep**: the two sections take the same settings slice; the overlap is a type, not behaviour |
| `SiteTreeRows.tsx`, `useColumnDragReorder.ts`, `useSiteDragController.ts`, `AppDialogs.tsx`, `createPaneSessionLifecycle.ts` with themselves | 44 | **Keep**: branches of one drag or dialog lifecycle that differ in the lines around the clone |
| `panes.css` ↔ `transfers.css` | 7 | **Keep**: two components that look alike without sharing a visual contract |

The remaining Rust production clones are under 20 lines each and are reviewed when their code
changes. Rust test clones are fixtures and assertions that each test states on its own.

jscpd does not see semantic copies whose names and strings differ. The import and export dialogs
are the known example; code review keeps looking for that kind of repetition.
