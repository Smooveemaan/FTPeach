# P2 resilience changes

WebDAV upload bodies use a paced reader, a 64 KiB duplex pipe and a 64 KiB HTTP stream buffer. A process-wide semaphore admits at most 16 bodies; the application body buffers total approximately 3 MiB, independently of file size. This excludes HTTP/TLS and operating-system socket buffers. Known-length uploads cannot read beyond the declared length, and local source length is checked again before committing the staging object. Unknown-length relay uses a streaming request. Servers that reject it return an error; there is no unbounded buffered fallback.

Recursive operations now enter through one backend intent. The application coordinator owns scanning, validation, reservations, execution, verification, deletion and the final report. Manifest, scan, I/O adapters and coordination live in separate modules. Limits are 100,000 manifest entries including the root, a 32 MiB manifest payload budget, depth 40, two concurrent manifests, one active child transfer per operation and at most 100 reported errors. Local scan failures propagate; scan cancellation is checked between entries. Child cancellation completes before reservations are released, including when the IPC caller disappears.

Skip merges missing files into existing directories and preserves conflicting files. Its destination-conflict set has a separate 100,000-entry/32 MiB payload budget. A move with skipped files retains the source and reports a partial result. Existing remote directories are checked before mkdir, including on SFTP retries.

Move deletes source entries only after successful copying and an unchanged source manifest. Empty directories are included. FTP/SFTP deletion uses an empty-directory operation; WebDAV remote-to-local move is refused because recursive DELETE cannot guarantee that newly appearing children survive. Cross-session remote move remains refused. External-process filesystem races and crash-atomic transactions spanning multiple stores are not claimed to be solved by these changes.

Navigation commits back/forward stacks only after the winning listing succeeds. Transfer rows form a discriminated union; each retry owns a new attempt ID, and stale events cannot settle a replacement attempt. Recursive rows use the same attempt ownership and cancellation lifecycle. Successful history is retained to 1,000 rows; retryable error, stopped and paused rows remain available. Attempt and active-target indexes are rebuilt when publishing a store snapshot.

| Event | State transition | Ownership |
| --- | --- | --- |
| Start/retry | queued, then progress | New attempt ID; retry waits for the previous attempt to settle |
| Pause/stop | cancelling, then paused/stopped | Keep the existing attempt until backend acknowledgement; recursive operations support stop |
| Completion/failure | done/error | Only the current attempt can settle the row; a completed commit wins a late cancellation |
| Late progress/completion | unchanged | Events from replaced attempts are discarded |

Settings persistence runs outside React state updater callbacks. A 75 ms coalescing window merges changes, and revisions serialize writes so a newer update follows an in-flight write. StrictMode tests cover combined width/order changes and preservation of the last value.

Settings/sites recovery reports warnings through their API responses. Unsupported schemas and unreadable stores become read-only instead of being silently replaced by defaults. Missing or corrupt main files may recover from last-good copies, with a visible warning. Site/vault updates retain previous secret values and restore them after a failed site write; failed vault commits restore in-memory secrets as well. Import rollback uses raw site snapshots, preserving encrypted fields, and reports rollback failures. Windows sharing-violation tests exercise real rename/commit failures.

Vault metadata is capped at 64 KiB. Accepted Argon2id version-1 parameters have ceilings of 64 MiB memory, three iterations and one lane; production defaults are unchanged. KDF work runs on the blocking executor under a single permit owned by the actual computation, so cancellation of its caller cannot start a second KDF early.

WebDAV parsing applies only successful propstat values and preserves unknown sizes. Relay integrity checks distinguish unknown length from an empty file. Known WebDAV authentication, timeout and range/integrity failures use structured error codes. Confirmation-window creation and styling belong to runtime; security retains authorization policy. Local filesystem writers and downloads share mutation coordination and target reservations. The Rust boundary gate enforces the presentation boundary and includes application modules.

## Reproducing validation

- `npm test` and `npm run lint`
- `npm run rust:test` and `npm run rust:clippy`
- `npm run check:rust-boundaries` and `npm run build`
- `node --experimental-strip-types scripts/benchmarks/benchmark-transfer-history.ts`
- `node --experimental-strip-types scripts/benchmarks/benchmark-transfer-ui.ts`

The history benchmark measures store update cost. The browser benchmark measures mutation-to-DOM-commit latency in Chromium using the visual application harness, with the previous unbounded store algorithm and the current implementation. It does not measure native WebView presentation or network throughput. Live protocol compatibility and packaged native smoke are separate release checks.

The audit's A28 findings remain outside P2: the Cyrillic-policy failure in the visual test and the existing site-manager screenshot mismatch require their own resolution. A failed overall `npm run check` must not be reported as a green release gate.

## Recorded validation (Windows, 2026-09-07)

`npm test`: 191 Node tests and 103 component tests passed. `npm run rust:test`: 239 passed, four live tests ignored; the Docker target ran zero tests without its integration configuration. Lint/typecheck, Clippy, formatting, feature/Rust boundaries, duplication threshold, all 26 locale checks, frontend bundle budget, native debug build and updater fixtures passed. The signed updater fixture was accepted and its damaged counterpart rejected.

The overall check stops on the existing Cyrillic-policy failure. Visual tests had seven passes and the existing site-manager screenshot failure; its baseline was not changed.

New regressions cover 17 declared-gigabyte uploads with only 16 admitted readers, 64 KiB maximum reader requests, a length-bounded growing source, incremental progress and HTTP delivery in 250 ms windows. The pacing test uses a separate limiter and drains its intentional one-second startup bucket before measuring steady-state behavior. Other cases cover 100k manifest entries, cancellation during scanning, depth limits, partial failures, empty directories, nested Skip behavior, navigation races, rejected recursive IPC, storage recovery/Windows commit failures, KDF budgets and cancellation, mixed propstat statuses, unknown versus zero relay size, and invalid ranges.

The standalone browser run used the same application UI with either the previous unbounded store algorithm or the current store. Five DOM-commit samples followed two warm-up updates. A 100k unbounded scenario was stopped after 30 seconds including initial rendering; this is a scenario timeout, not a measured per-update latency.

| Completed history input | Previous DOM commit median | Current DOM commit median | Current p95 | Retained rows including active |
| --- | --- | --- | --- | --- |
| 10,000 | 2293.90 ms | 264.70 ms | 272.50 ms | 1001 |
| 100,000 | Scenario timeout | 210.00 ms | 213.50 ms | 1001 |

| Completed history input | Previous store-update median | Current store-update median |
| --- | --- | --- |
| 10,000 | 0.115 ms | 0.123 ms |
| 100,000 | 2.264 ms | 0.794 ms |

The 10k store-only update has a small indexing overhead; the large UI improvement comes from controlled history retention. Even the retained queue still renders hundreds of milliseconds in this harness, so these results do not establish a 60 fps interface.

Detailed run logs are kept locally under `.local/logs/p2-*-final.log`; the benchmark scripts are tracked for reproduction. Live servers, packaged native smoke and crash injection between separate store commits were not exercised by this P2 run.
