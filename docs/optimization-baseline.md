# Stage 0: reproducible baseline and P0 regressions

Run `npm run benchmark:baseline -- .local/benchmarks/stage-0.json` on an idle machine, without tests or another benchmark running. Repeat the command into a second file before treating a difference as a regression. This is a measurement tool, not a timing assertion in ordinary CI. Keep Node version, hardware, power mode and fixture version fixed when comparing revisions.

The JSON includes schema/fixture versions, commit and dirty flag, environment, all 40 samples after 5 warmups, nearest-rank p50/p95/p99, CPU usage and process memory. Memory is an end-of-scenario process snapshot (not an allocation count, peak, leak measurement or isolated retained heap). Forty samples do not establish a reliable tail SLA; p99 is descriptive. Fixtures use fixed IDs/times and synthetic paths only. The artifact contains no server credentials or file contents.

## Workloads

- Mixed queues: 1,000 / 10,000 / 100,000 input rows and 1 / 8 / 32 active attempts. Remaining rows cycle through queued, paused, error, stopped and done. Existing successful-history retention is applied; the artifact records actual retained size and status counts so retention cannot masquerade as handling the full input size.
- Progress burst: one update for each active attempt, using the current store update and attempt lookup APIs. Each sample times the whole burst, including synchronous subscriber notification. Final byte counts are asserted. This is not the IPC adapter or an already coalesced batch.
- Large directory: the same three sizes, fixed names/types/timestamps, name sorting with and without a filter. Fixture construction is outside timing.

The older `benchmark:frontend`, `benchmark:transfer-history` and `benchmark:transfer-ui` commands remain available. Their completed-history and Chromium results are separate scenarios, not interchangeable with the mixed-queue baseline.

## P0 acceptance matrix

All tests below are in `src-tauri/src/application/recursive_transfer/tests.rs` and run with `npm run rust:test`. Local files are created only under unique temporary roots; remote cases use the in-memory `Server`, never a user's server. Hooks interrupt after a delivered file or inject a mutation after the final scan, without timing-dependent sleeps.

| Contract | Regression tests |
| --- | --- |
| Resume Copy/Move rejects removed or changed local destinations, including restored mtime | `resume_rejects_a_changed_or_missing_destination` |
| A directory replaces a delivered file despite prior overwrite consent; its children and both sources survive | `resume_preserves_directory_replacement_even_with_overwrite_consent` |
| Upload, download and remote relay reject changed/missing/directory destinations | `remote_directions_reject_changed_missing_or_directory_destinations_on_resume` |
| Missing remote metadata fails closed | `resume_with_missing_remote_metadata_retains_source_and_destination` |
| Stop retains a replacement and an in-place same-size/restored-mtime edit, returns structured cleanup details | `stop_preserves_an_external_replacement_with_restored_timestamp`, `stop_preserves_in_place_changes_and_reports_cleanup_details` |
| Replacement directories and external children survive rollback | `rollback_preserves_a_replacement_directory_and_new_children` |
| Foreign staging and unverifiable remote objects survive; retained staging cannot later be removed by disconnect | `stopping_a_paused_upload_retains_unverifiable_objects_and_foreign_staging` |
| Source replacement/in-place change after final scan survives, even with original size/mtime | `move_preserves_source_changes_after_final_scan` |
| Destination mutation before source deletion preserves source | `move_rechecks_destination_immediately_before_source_deletion` |
| Protected Windows handles deny writes/replacement through deletion | `protected_file_rejects_writes_and_replacement_until_handle_deletion` |
| Unsupported remote copy/delete Move fails before writes | `copy_delete_moves_with_remote_endpoints_are_rejected_before_writes` |

Stage 1 predates this baseline: existing regressions are retained and the missing local directory/overwrite and in-place Stop cases are added. Passing now verifies the fixed behavior; it does not claim that the historical bugs were rerun on an old executable. The remote rollback path refuses deletion without ownership, so it does not open a WebDAV LIST/DELETE race at all. Real protocol implementations still need the disposable-server compatibility suite before release.

See [transfer safety](transfer-safety.md#recursive-p0-contracts-september-13-2026) for supported guarantees and explicit limits: remote Copy uses size/mtime, remote copy/delete Move is refused, unverified rollback objects remain, and local Move needs protected Windows handles. Equal-size remote changes with unchanged server mtime are not detected.

## Initial measurement (September 13, 2026)

Measured on the working tree based on `e555ef0`; the machine-readable run is `.local/benchmarks/stage-0.json`. The new instrumentation and tests were uncommitted (`dirty: true`); application/store code was unchanged. No tests ran concurrently.

| Input rows | Active attempts | Burst p50 ms | Burst p95 ms |
| --- | --- | --- | --- |
| 1,000 | 1 | 0.10 | 0.37 |
| 1,000 | 8 | 0.64 | 1.04 |
| 1,000 | 32 | 2.78 | 4.02 |
| 10,000 | 1 | 1.20 | 2.18 |
| 10,000 | 8 | 10.60 | 18.07 |
| 10,000 | 32 | 43.83 | 59.37 |
| 100,000 | 1 | 18.91 | 27.75 |
| 100,000 | 8 | 135.87 | 165.63 |
| 100,000 | 32 | 643.18 | 731.53 |

These establish the cost of the existing synchronous store, not a WebView frame rate or throughput promise. Release WebView2 input/scroll/React commits, IPC event rate, native handles/connections, scan/mkdir/transfer/verify/cleanup timings at controlled RTT, Docker failures and an 8–24 hour soak remain dedicated later-stage measurements. No release gate is claimed from this local baseline.
