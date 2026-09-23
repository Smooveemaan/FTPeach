# Duplication

`npm run check:duplicates` runs `scripts/checks/check-duplicates.ts`: jscpd 5.2.1 with at least
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

Baseline of 24 September 2026:

| Area | Files | Code lines | Clones | Duplicated lines | Share |
| --- | ---: | ---: | ---: | ---: | ---: |
| frontend-ts | 209 | 31,750 | 9 | 87 | 0.27% |
| css | 23 | 4,667 | 1 | 6 | 0.13% |
| rust-production | 120 | 27,149 | 40 | 407 | 1.50% |
| rust-tests | 88 | 20,462 | 95 | 888 | 4.34% |

## Findings and decisions

Groups of at least 20 duplicated lines, and every frontend and CSS clone. IDs refer to the audit in
the hotfix plan.

| Where | Lines | Decision |
| --- | ---: | --- |
| `protocol/ftp.rs` ↔ `sftp.rs` ↔ `webdav.rs`, download preparation and completion (D-01) | 34 | **Removed** (HF-26): `DownloadTarget` and `LocalDownload` in `protocol/transfer_file.rs` |
| `protocol/ftp.rs` ↔ `sftp.rs` ↔ `webdav.rs`, upload completion, connect, listing, create-file | 184 | **Defer**: upload completion can follow the download lifecycle once its no-replace guarantees are settled; connect and listing differ in each protocol's handshake and reply parsing |
| `commands/fs.rs` with itself, mkdir/create-file reservation and checks (D-02) | 40 | **Removed** (HF-27): `local_fs::local_create` owns both operations |
| `commands/fs.rs` with itself, rename and copy prologues | 21 | **Defer**: copy already runs in `local_fs::staged_copy`; rename moves with its own change, since it carries the no-replace guarantee (HF-02) |
| `protocol/ftp.rs` with itself: `upload`/`upload_from_reader`, `download`/`download_to_writer`, rustls `verify_tls12/13_signature` | 63 | **Keep**: file and stream transfer loops differ in their source and resume handling, and rustls requires both verifier methods |
| `commands/session/browse.rs`, validate-and-reserve prologue of mkdir/create/delete | 24 | **Keep**: three lines of prologue per command; the reservation guard has to live in each command's own scope |
| `commands/dialog.rs`, native picker boilerplate | 23 | **Defer**: a picker helper when another picker is added; the filters and what is approved differ per picker |
| `sites/SiteSearchResults.tsx` ↔ `SiteTree.tsx`, site context menu (D-03) | 12 | **Remove**: one site-menu factory (HF-28) |
| `useSettingsTransfer.ts` ↔ `platform/global.d.ts`, import/export result types (D-05) | 12 | **Removed** (HF-29): one contract in `platform/api/settings.ts` |
| `useTransferLifecycle.ts` with itself, moving an attempt to queued (D-07) | 12 | **Remove**: one transition (HF-31) |
| `ToolbarOverflowMenu.tsx` ↔ `PaneSourceSwitcher.tsx`, overlay position (D-06) | 15 | **Remove**: shared overlay geometry (HF-30) |
| `ConnectionSettings.tsx` ↔ `ProxySettings.tsx`, props interface | 13 | **Keep**: the two sections take the same settings slice; the overlap is a type, not behaviour |
| `SiteTreeRows.tsx`, `useColumnDragReorder.ts`, `useSiteDragController.ts`, `AppDialogs.tsx`, `createPaneSessionLifecycle.ts` with themselves | 44 | **Keep**: branches of one drag or dialog lifecycle that differ in the lines around the clone |
| `panes.css` ↔ `transfers.css` (D-08) | 7 | **Keep**: two components that look alike without sharing a visual contract |

The remaining Rust production clones are under 20 lines each and are reviewed when their code
changes. Rust test clones are fixtures and assertions that each test states on its own.

jscpd does not see semantic copies whose names and strings differ. The import and export dialogs
(D-04, HF-29) are the known example; code review keeps looking for that kind of repetition.
