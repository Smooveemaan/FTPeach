# Stage 2: lifecycle and resource budgets

This implements items 6–9 of the optimization plan. Transfer queue storage,
virtualization and progress batching remain stage 3 work.

## Paused recursive operations

The backend retains at most 32 journals and an estimated 64 MiB across them.
The estimate includes allocated collection capacity, path strings, timestamps
and receipts. A new pause that cannot fit is refused; existing journals are
never evicted. The response has `paused: false` and a `cleanupIncomplete`
diagnostic. The UI settles the row as an error, so Retry starts a new operation
instead of requesting a missing journal. Written results are retained.

Resume consumes its journal; Stop consumes it before attempting safe cleanup.
Disconnect cancels matching recursive operations and releases their paused
journals, logging retained target roots. Stop with an unavailable journal
reports that written results may remain. Safety checks from stage 1 still
govern deletion. Journals remain in RAM only; crash/restart recovery is not
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

## Reproduction and measurement

Run `npm run benchmark:listing` without concurrent tests. It creates and removes
a uniquely named temporary directory with 100,001 files and writes
`.local/benchmarks/stage-2-listing.json`. The artifact records the commit, dirty
flag, OS, architecture, logical CPU count, fixture version, raw timing samples
and the production listing's budget error. The fixture contains no user data.
Two warmups precede six measured samples for each candidate. This is a debug
build comparison of enumeration plus metadata, not a WebView or p95 gate.

The first local run on Windows/x86-64 (16 logical CPUs), based on `e0d7bc5`
with the stage 2 changes uncommitted, measured median times of about 1,353 ms
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

Regression coverage includes 33+ pause attempts without eviction, aggregate
journal memory rejection, stalled remove/disconnect with 40 paused uploads,
10,000 missing session lookups and failed creations, 10,000 frontend metadata
lifecycles, metadata failure injection, cancellation during enumeration, late
successful replies after disconnect, and local navigation/unmount cancellation.
The full Rust and frontend suites also retain stage 1's data-safety scenarios.

Validation: 380 Rust library tests plus 4 example tests passed (9 ignored),
256 frontend unit tests and 275 component tests passed. ESLint, TypeScript,
Clippy with warnings denied, formatting, architecture checks and the renderer
production build with its bundle budget passed.

Live SMB faults, Docker compatibility, packaged WebView checks and long soak
runs are not covered by these local tests; the release checks remain stage 5.
