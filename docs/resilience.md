# Resilience and resource budgets

How transfers, recursive operations, disconnects, listings, the transfer queue
and the stores stay within fixed memory and time budgets, and what happens when
one of them fails part way.

## Uploads

WebDAV upload bodies use a paced reader, a 64 KiB duplex pipe and a 64 KiB HTTP stream buffer. A process-wide semaphore admits at most 16 bodies; the application body buffers total approximately 3 MiB, independently of file size. This excludes HTTP/TLS and operating-system socket buffers. Known-length uploads cannot read beyond the declared length, and local source length is checked again before committing the staging object. Unknown-length relay uses a streaming request. Servers that reject it return an error; there is no unbounded buffered fallback.

WebDAV parsing applies only successful propstat values and preserves unknown sizes. Relay integrity checks distinguish unknown length from an empty file. Known WebDAV authentication, timeout and range/integrity failures use structured error codes.

## Recursive operations

Recursive operations enter through one backend intent. The application coordinator owns scanning, validation, reservations, execution, verification, deletion and the final report. Manifest, scan, I/O adapters and coordination live in separate modules. Limits are 100,000 manifest entries including the root, a 32 MiB manifest payload budget, depth 40, two concurrent manifests, one active child transfer per operation and at most 100 reported errors. Local scan failures propagate; scan cancellation is checked between entries. Child cancellation completes before reservations are released, including when the IPC caller disappears.

Skip merges missing files into existing directories and preserves conflicting files. Its destination-conflict set has a separate 100,000-entry/32 MiB payload budget. A move with skipped files retains the source and reports a partial result. Existing remote directories are checked before mkdir, including on SFTP retries.

Move deletes source entries only after successful copying and an unchanged source manifest. Empty directories are included. Copy/delete Move runs only between local folders; every Move between the computer and a server, or between two connections, is refused before it starts (see the [guarantee matrix](transfer-safety.md#guarantee-matrix)). External-process filesystem races and crash-atomic transactions spanning multiple stores are not claimed to be solved.

Local filesystem writers and downloads share mutation coordination and target reservations.

### Paused recursive operations

The backend retains at most 32 journals and an estimated 64 MiB across them.
The estimate includes allocated collection capacity, path strings, timestamps
and receipts. A new pause that cannot fit is refused; existing journals are
never evicted. The response has `paused: false` and a `cleanupIncomplete`
diagnostic. The UI settles the row as an error, so Retry starts a new operation
instead of requesting a missing journal. Written results are retained.

Resume consumes its journal; Stop consumes it before attempting safe cleanup.
Disconnect cancels matching recursive operations and releases their paused
journals, logging retained target roots. Stop with an unavailable journal
reports that written results may remain. The recursive-operation safety checks
still govern deletion. Journals remain in RAM only; crash/restart recovery is not
implemented or offered.

## Disconnect

The frontend signals Stop and initiates backend disconnect concurrently.
Backend disconnect removes the session from lookup immediately and uses one
five-second outer deadline, including waiting for the browse lock. Teardown
cancels the transfer pool before waiting for writers and attempting staging
cleanup. A pool handle registered alongside the slot makes cancellation
reachable even while a browse operation holds its lock. Pool cancellation
also runs when a session is dropped at the deadline.
The ordinary timeout and shutdown paths release staging registry entries even
when their future is cancelled.

Cleanup logs exact pending staging paths before awaiting network deletion, so
an interrupted cleanup still leaves diagnostics. A timeout can leave server
files; it does not authorize deletion of an unverified final destination.
Frontend Stop requests have a five-second budget and disconnected queue rows
leave `cancelling` even when cleanup fails. A kernel filesystem operation or
remote operation may outlive the caller's deadline; detaching the session does
not mean that a stalled operating-system call has been forcibly terminated.

## Connection registries

`get_existing`/`lookup_slot` do not register missing IDs. Creation is explicit
through `get_or_create`. Lookup guards remove empty slots on every exit,
including failure and concurrent access; pointer identity prevents removal
of a replacement slot. Disconnect detaches the registered slot immediately.

Frontend labels and disconnect tombstones are retained for queue rows, live
connection labels, pane references and pending listing responses. They are
released after the last reference disappears, without timer expiry. Log labels
use their separate existing 200-entry cache. A pending request holds its reference
until its response settles, including a successful response received after
disconnect. Attempt-ID protection for late transfer events is unchanged.

## Local listing

Listing refuses more than 100,000 entries or an estimated 32 MiB rather than
returning a truncated successful list. Metadata errors fail the listing with
the entry name and error; inaccessible directories are never synthesized as
zero-byte files. The previous panel data is retained when listing fails.

Requests have unique cancellation keys. Navigation and unmount abort obsolete
requests; request generation checks also reject late results. The whole
command has a 30-second deadline, including validation, listing and approval
of paths for opening. Four command slots bound simultaneous result buffers.
Enumeration uses a blocking worker with cancellation checks between entries.
Its four-worker limit is held until the worker actually returns. Path
canonicalization also runs off the async executor, holds its command permit
until it returns, and checks cancellation between entries. Cancellation cannot
interrupt an individual Windows/SMB kernel call already in progress.

## Navigation and the transfer queue

Navigation commits back/forward stacks only after the winning listing succeeds. Transfer rows form a discriminated union; each retry owns a new attempt ID, and stale events cannot settle a replacement attempt. Recursive rows use the same attempt ownership and cancellation lifecycle. History retains the newest 1,000 successful rows and, separately, the newest
1,000 failed or stopped rows, ordered by completion. Paused and active rows are
not evicted. Admission allows at most 1,000 active rows (queued, running or
cancelling) and 10,000 total rows. Attempt and active-target indexes are updated
on structural row changes; byte-only progress leaves them and the summary intact.

| Event | State transition | Ownership |
| --- | --- | --- |
| Start/retry | queued, then progress | New attempt ID; retry waits for the previous attempt to settle |
| Pause/stop | cancelling, then paused/stopped, or error if cleanup fails | Keep the existing attempt until backend acknowledgement; Pause is offered only where the row can resume |
| Completion/failure | done/error | Only the current attempt can settle the row; a completed commit wins a late cancellation |
| Late progress/completion | unchanged | Events from replaced attempts are discarded |

## Settings, sites and the vault

Settings persistence runs outside React state updater callbacks. A 75 ms coalescing window merges changes, and revisions serialize writes so a newer update follows an in-flight write. StrictMode tests cover combined width/order changes and preservation of the last value.

Settings/sites recovery reports warnings through their API responses. Unsupported schemas and unreadable stores become read-only instead of being silently replaced by defaults. Missing or corrupt main files may recover from last-good copies, with a visible warning. Site/vault updates retain previous secret values and restore them after a failed site write; failed vault commits restore in-memory secrets as well. Import rollback uses raw site snapshots, preserving encrypted fields, and reports rollback failures. Windows sharing-violation tests exercise real rename/commit failures. Crash injection between separate store commits is not exercised by any suite.

Vault metadata is capped at 64 KiB. Accepted Argon2id version-1 parameters have ceilings of 64 MiB memory, three iterations and one lane; production defaults are unchanged. KDF work runs on the blocking executor under a single permit owned by the actual computation, so cancellation of its caller cannot start a second KDF early.

## Tests

Regressions cover 17 declared-gigabyte uploads with only 16 admitted readers, 64 KiB maximum reader requests, a length-bounded growing source, incremental progress and HTTP delivery in 250 ms windows. The pacing test uses a separate limiter and drains its intentional one-second startup bucket before measuring steady-state behavior. Other cases cover 100k manifest entries, cancellation during scanning, depth limits, partial failures, empty directories, nested Skip behavior, navigation races, rejected recursive IPC, storage recovery/Windows commit failures, KDF budgets and cancellation, mixed propstat statuses, unknown versus zero relay size, and invalid ranges.

Lifecycle coverage includes 33+ pause attempts without eviction, aggregate
journal memory rejection, stalled remove/disconnect with 40 paused uploads,
10,000 missing session lookups and failed creations, 10,000 frontend metadata
lifecycles, metadata failure injection, cancellation during enumeration, late
successful replies after disconnect, and local navigation/unmount cancellation.

Live SMB faults and repeated application cycles are exercised by closed suites outside
the default one ([How releases are verified](release-trust.md#how-releases-are-verified)). Their existence does not turn the
historical measurements below into SMB or long-duration performance results.

## Measurements

### Transfer history, 2026-09-07

Reproduce with:

- `node --experimental-strip-types scripts/benchmarks/benchmark-transfer-history.ts`
- `node --experimental-strip-types scripts/benchmarks/benchmark-transfer-ui.ts`

The history benchmark measures store update cost. The browser benchmark measures mutation-to-DOM-commit latency in Chromium using the visual application harness, with the previous unbounded store algorithm and the current implementation. It does not measure native WebView presentation or network throughput.

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

### Local listing

Run `npm run benchmark:listing` without concurrent tests. It creates and removes
a uniquely named temporary directory with 100,001 files and writes
`.local/benchmarks/listing.json`. The artifact records the commit, dirty
flag, OS, architecture, logical CPU count, fixture version, raw timing samples
and the production listing's budget error. The fixture contains no user data.
Two warmups precede six measured samples for each candidate. This is a debug
build comparison of enumeration plus metadata, not a WebView or p95 gate.

The first local run on Windows/x86-64 (16 logical CPUs), based on `e0d7bc5`
with the listing changes uncommitted, measured median times of about 1,353 ms
for serial Tokio, 82 ms for one blocking task and 1,004 ms for concurrency 8.
The production listing correctly rejected the 100,001st entry. This supports
selecting the single blocking worker on this filesystem. No SMB endpoint was
available for measurement; repeat the example with an explicit third argument
pointing to a disposable directory on the target share before making SMB
performance claims. A repeat run measured approximately 1,574 / 75 / 1,813 ms
for the three candidates. The production bounded listing, including entry
formatting and budget checks, rejected the oversized directory in 401 ms
after the change, versus 1,788 ms before it. These are descriptive local
observations; the raw candidate timings exclude entry formatting.
