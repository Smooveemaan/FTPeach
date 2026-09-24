# Code coverage

Each test runner reports its own coverage. They measure different things, so their percentages sit
side by side and are never added or averaged.

| Runner | Command | Counts | Report |
| --- | --- | --- | --- |
| Node unit suite | `npm run coverage` | Lines, branches and functions of the modules the suite loads (`--test-coverage-include=src/**`) | `coverage/unit/lcov.info` |
| Component suite (Vitest, jsdom) | `npm run coverage` | Every file under `src/**/*.{ts,tsx}`, loaded or not | `coverage/component/` (HTML, JSON, summary) |
| Rust (`cargo llvm-cov`) | `npm run rust:coverage` | Lines and functions of the Windows build of `src-tauri/src`, without test files | `coverage/rust/lcov.info` |

`scripts/coverage/coverage.ts` runs the two frontend suites and prints one table per runner to the
console, to `coverage/summary.md` and to the CI job summary. A failing test fails the command before
any report is read. Not in the denominators:

- declarations (`*.d.ts`) and generated `src/graphify-out/`; tests are outside `src/`;
- Node cannot count a module it never loaded. The report lists every such production file with
  zero found lines and says how many there are; the component report covers them;
- Rust test files (`tests.rs`, `*_tests.rs`, `src-tauri/tests/`); inline `#[cfg(test)]` modules in
  production files still count, because llvm-cov reports them as part of the file;
- Rust code behind `cfg(not(windows))`, which the Windows build never compiles. Rust branch coverage
  needs a nightly toolchain and is shown as not measured.

Skipped and todo tests are counted in each frontend section. The `#[ignore]` Rust tests — live
servers, Docker, a second volume, privileges — do not run under coverage; the Rust section gives
their count, and [the verification matrix](verification-matrix.md) says what each needs.

## Floors

`scripts/coverage/coverage-floors.json` gives the modules behind the P0/P1 guarantees a floor on
line coverage, per runner. The command fails when such a file drops below its floor or disappears
from its report, so a rename has to move its floor too. Floors sit two points below the baseline
below: slack for a harmless refactor, not for a lost test. There is deliberately no floor for the
whole project and no 100% target.

A line percentage does not prove a guarantee. The scenarios that do — no-replace, keeping the old
target, checking the source before delete, recovering a dirty file, failed envelopes, cancellation
and settling — are listed per task in the [verification matrix](verification-matrix.md) and per
protocol in the [guarantee matrix](transfer-safety.md#guarantee-matrix).

CI runs the frontend command in `lint-test-build` and the Rust command in `rust-coverage`, and keeps
both `coverage/` directories as artifacts. `check:ci-parity` checks that `npm run check` runs what CI
runs; it measures no coverage.

## Baseline of 24 September 2026

| Runner | Files | Lines | Branches | Functions |
| --- | ---: | ---: | ---: | ---: |
| unit | 228 (148 not loaded) | 72.30% (7,380/10,207) | 87.46% | 73.61% |
| component | 228 (42 with no line run) | 60.57% (4,980/8,222) | 48.34% | 53.10% |
| rust | 112 | 72.34% (18,488/25,557) | not measured | 69.90% |

| Floored module | Runner | Baseline lines |
| --- | --- | ---: |
| `shared/lang.ts`, `platform/shutdownPersistence.ts` | unit | 100% |
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
floors keep them from slipping further, and their scenarios are covered by the native checks in the
verification matrix.

Not done yet: a floor on the lines a change touches. Add it when a pull request lands untested
changes in a floored module despite these floors.
