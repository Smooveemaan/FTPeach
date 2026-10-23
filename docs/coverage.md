# Code coverage

Each test runner reports its own coverage. They measure different things, so their percentages sit
side by side and are never added or averaged.

| Runner | Command | Counts | Report |
| --- | --- | --- | --- |
| Node unit suite | `npm run coverage` | Lines, branches and functions of the modules the suite loads (`--test-coverage-include=src/**`) | `coverage/unit/lcov.info` |
| Component suite (Vitest, jsdom) | `npm run coverage` | Every file under `src/**/*.{ts,tsx}`, loaded or not | `coverage/component/` (HTML, JSON, summary, LCOV) |
| Rust (`cargo llvm-cov`) | `npm run rust:coverage` | Lines and functions of the Windows build of `src-tauri/src`, without test files | `coverage/rust/lcov.info` |

`scripts/coverage/coverage.ts` runs the two frontend suites and prints one table per runner to the
console, to `coverage/summary.md` and to the CI job summary. A failing test fails the command before
any report is read. Not in the denominators:

- declarations (`*.d.ts`) and generated `src/graphify-out/`; tests are outside `src/`;
- Node cannot count a module it never loaded. The report lists every such production file with
  zero found lines in the unit section's expandable table and says how many there are;
  the component report covers them;
- Rust test files (`tests.rs`, `*_tests.rs`, `src-tauri/tests/`); inline `#[cfg(test)]` modules in
  production files still count, because llvm-cov reports them as part of the file;
- Rust code behind `cfg(not(windows))`, which the Windows build never compiles. Rust branch coverage
  needs a nightly toolchain and is shown as not measured.

Skipped and todo tests are counted in each frontend section. The `#[ignore]` Rust tests — live
servers, a second volume, privileges — do not run under coverage; the Rust section gives
their count, and [the table below](#ignored-rust-tests) says what each needs.

## Ignored Rust tests

Each `#[ignore]` names its reason, and `npm run check:ignored-tests` fails when an ignored test is
missing from this table. The default run reports them as ignored; the count is the number of checks
that did not run. The last results are historical, not checks of the current tree.

| Test | Needs | Command | Last result |
| --- | --- | --- | --- |
| `connects_and_round_trips_a_file` | a WebDAV server in `WEBDAV_URL`, `WEBDAV_USER`, `WEBDAV_PASS` | `npm run rust:test -- connects_and_round_trips_a_file --ignored` | NOT RUN: no external server |
| `cross_volume_disk_move` | a second writable volume in `FTPEACH_MOVE_TEST_VOLUME` | `npm run rust:test -- cross_volume_disk_move --ignored` | PASS, C: to an NTFS drive, 2026-10-08 |
| `artifact_symlink_cannot_write_to_its_target` | Developer Mode or SeCreateSymbolicLinkPrivilege | `npm run rust:test -- artifact_symlink_cannot_write --ignored` | NOT RUN: privilege not held (1314) |
| `connect_without_proxy_supports_ipv6_when_loopback_is_available` | the firewall allowing IPv6 loopback connects | `npm run rust:test -- connect_without_proxy_supports_ipv6 --ignored` | NOT RUN: connect to ::1 refused (EACCES) |
| `endless_reply_under_a_memory_cap` | nothing; its parent test runs it under a 128 MiB cap | runs inside `an_endless_reply_fits_in_a_process_with_a_hard_memory_cap` | PASS through the parent |

## Floors

`scripts/coverage/coverage-floors.json` gives the modules behind the P0/P1 guarantees a floor on
line coverage, per runner. The command fails when such a file drops below its floor, disappears
from its report or is in it with no measured lines (the unit report lists modules the Node suite
never loaded with zero lines, which must not pass as 100%), so a rename has to move its floor too. The original floors sat two points below the historical baseline
below. The JSON file records the current floors: slack for a harmless refactor, not for a lost test. There is deliberately no floor for the
whole project and no 100% target.

A line percentage does not prove a guarantee. The scenarios that do — no-replace, keeping the old
target, checking the source before delete, recovering a dirty file, failed envelopes, cancellation
and settling — are checked by the end-to-end and server suites a release waits for
([How releases are verified](release-trust.md#how-releases-are-verified)) and listed per protocol
in the [guarantee matrix](transfer-safety.md#guarantee-matrix).

CI runs the frontend command in `lint-test-build` and the Rust command in `rust-coverage`, and keeps
both `coverage/` directories as artifacts. `npm run check` runs both too; off CI the changed
lines are compared with `origin/master`, what CI compares a push with, unless
`COVERAGE_DIFF_BASE` names another commit. `check:ci-parity` checks that every npm step in
`checks.yml` is reachable from `npm run check`; it measures no coverage itself.

## Baseline of 24 September 2026

| Runner | Files | Lines | Branches | Functions |
| --- | ---: | ---: | ---: | ---: |
| unit | 227 (148 not loaded) | 72.25% (7,357/10,182) | 87.43% | 73.57% |
| component | 227 (33 with no line run) | 70.27% (5,778/8,223) | 57.05% | 61.34% |
| rust | 112 | 72.82% (18,791/25,804) | not measured | 70.51% |

The coverage expansion adds 92 component scenarios and five native drag manifest tests.
Compared with the measured pre-expansion checkout, component line coverage rose from 60.57%
to 70.27%, branch coverage from 48.36% to 57.05%, and Rust line coverage from 72.77% to 72.82%.
The Node suite is unchanged; the component suite now tests complete pane flows rather than
duplicating the individual navigation helpers' Node tests.

- [Pane flows](../test/component/file-browser/usePanes.test.tsx) exercise navigation history,
  synchronized browsing, cancellation, late replies, closing active transfers, reconnecting and
  overwrite decisions. [Context menus](../test/component/file-browser/paneActions.test.ts) and
  [connection controls](../test/component/file-browser/connectionBar.test.tsx) check the actions
  and authorization flags passed to those flows.
- [Security confirmation](../test/component/platform/securityConfirmation.test.tsx) checks
  keyboard and button approval, phrase/password requirements, retry and cancellation.
  [Vault settings](../test/component/settings/vaultSettings.test.tsx) cover validation, failed
  actions, clearing password fields, auto-lock notifications and timer cleanup.
- [Open-with](../test/component/open-with/openWithDialog.test.tsx) checks download progress,
  cancellation against the original session, late watcher cleanup and failed results.
  [Tooltips](../test/component/shared/tooltip.test.tsx) cover focus, hover, positioning and cleanup;
  layout geometry is simulated in jsdom, not a native browser layout test.
- [Native manifest tests](../src-tauri/src/native_drag/manifest_tests.rs) run without a server:
  unsafe or duplicate Windows root names, UTF-16 descriptor lengths and excessive root counts
  fail before connecting. Recursive folder enumeration is checked against a real server.

| Floored module | Runner | Baseline lines |
| --- | --- | ---: |
| `shared/lang.ts`, `platform/shutdownPersistence.ts` | unit | 100% |
| `file-browser/usePanes.ts` | component | 98.98% |
| `settings/hooks/useVaultSettings.ts` | component | 100% |
| `platform/SecurityConfirmation.tsx` | component | 98.55% |
| `transfers/transferBatchResult.ts`, `shared/movePolicy.ts` | component | 100% |
| `open-with/useOpenWithLifecycle.ts` | component | 96.6% |
| `file-browser/panes/usePaneSessionPersistence.ts` | component | 86.9% |
| `transfers/createTransferRouting.ts` | component | 85.2% |
| `local_fs/local_create.rs`, `target_reservation.rs`, `staged_copy.rs`, `protocol/transfer_file.rs` | rust | 97–99% |
| `local_fs/filesystem_safety.rs` | rust | 94.3% |
| `application/recursive_transfer/mod.rs` | rust | 87.1% |
| `local_fs/open_with.rs` | rust | 78.3% |
| `commands/fs.rs` | rust | 48.9% |
| `runtime/shutdown.rs` | rust | 33.3% |

The last two are low because most of their code needs a Tauri runtime or a quitting process; their
floors keep them from slipping further, and their scenarios are covered by the desktop checks a
release waits for.

## Changed-line floors

CI also enforces each module's existing floor on its added or modified measured lines,
separately for each runner. This catches untested additions that a file's overall percentage can
hide. Only modules in `coverage-floors.json` participate; there is no project-wide or 100% target.
In Rust files, lines that only `#[cfg(test)]` builds compile are not product code and do not
count as changed lines; the whole-file floors still measure them as before.
The report includes a per-file changed-line table and fails if any of those floors is missed.

CI sets `COVERAGE_DIFF_BASE` to the pull request's base commit, or for a push to the commit the
branch pointed to before it, and fetches full history. Locally,
set it to a commit or ref before running either coverage command, for example in PowerShell:

```powershell
$env:COVERAGE_DIFF_BASE = 'HEAD'
npm run coverage
npm run rust:coverage
Remove-Item Env:COVERAGE_DIFF_BASE
```

The comparison includes tracked staged and unstaged changes against that commit. New files must
be staged and, if they need a floor, added to `coverage-floors.json`. Renames are treated as
deletion plus addition, so move the floor to the new path and cover its measured lines.
Deleted lines and lines absent from LCOV's line records do not count. A change with no measured
added lines has no changed-line floor. Missing or unmeasured floored files still fail the whole-file check.
An invalid or unavailable base fails the command rather than silently skipping this check.
Without `COVERAGE_DIFF_BASE` (a first push, a scheduled or manual run, a release tag), only
whole-file floors apply, and the report says the changed lines were not checked.
