# Frontend performance

## Bundle baseline

Production bundle sizes are measured with `npm run build`. Sizes below are minified output from
Vite 8.1.4 on 24 August 2026; gzip sizes are included for comparison.

| Build | Entry JavaScript | Entry gzip |
| --- | ---: | ---: |
| Before dialog splitting | 737.97 kB | 219.61 kB |
| After dialog splitting | 167.44 kB | 49.99 kB |
| After lazy locale loading | 182.78 kB | 53.45 kB |

Settings, Site Manager, About, settings export, and Open With are loaded on demand. In particular,
the Site Manager boundary keeps its DnD dependency graph out of the startup path. The generated
chunks intentionally share common dialog code rather than forcing a manual vendor chunk for each
dependency.

`npm run build` runs `scripts/checks/check-bundle-budget.ts` after Vite and fails when the entry chunk is
larger than 200 KiB or any JavaScript chunk is larger than 350 KiB. The limits apply to minified,
uncompressed files and leave enough headroom for small changes while detecting a lost lazy-loading
boundary.

Packaged startup timing is intentionally not used as a release gate at this stage. The Windows
`tauri-driver` setup opened its WebView on `ERR_FILE_NOT_FOUND` for both the baseline and current
debug binaries, so it could not provide a valid renderer-ready timestamp. Entry size and the bundle
budget remain the reproducible regression signals; they are not presented as wall-clock timing.

The icon component was audited alongside the split. Its lookup maps are intentionally dynamic: all
file-category icons are reachable through extension classification, all site icons are selectable
and may be restored from persisted settings, and the remaining icons have static call sites. There
are therefore no unreachable icon exports for the bundler to remove. Splitting individual SVG paths
would add asynchronous fallback behavior to frequently rendered controls for negligible savings.

Translation resources are loaded on demand. English is the eager fallback; each of the other 26
locales is emitted as an independent 25–56 kB chunk and fetched only when selected. Before this
split, every locale occupied a single 964.54 kB (265.50 kB gzip) startup chunk. The shared i18n
runtime and English fallback now occupy 74.72 kB (25.29 kB gzip).

## Large directories

Run `npm run benchmark:frontend` to exercise the same filtering, folders-first sorting, and file
metadata functions used by `FilePane`. The benchmark generates deterministic entries and reports
the median of five warm runs so it is useful for comparing changes on the same machine; it is not a
cross-machine CI timeout.

Baseline from Node.js on 24 August 2026:

| Entries | Name sort | Filter + modified sort | Icon + type metadata |
| ---: | ---: | ---: | ---: |
| 10,000 | 2.12 ms | 4.26 ms | 0.98 ms |
| 50,000 | 13.18 ms | 21.64 ms | 5.46 ms |
| 100,000 | 25.83 ms | 54.16 ms | 10.73 ms |

After caching each metadata sort key once per entry instead of recomputing it for every comparator
call, the same-machine 100,000-entry filtered/modified sort measured 14.60 ms (down from 56.87 ms
in the immediately preceding baseline run). Name sorting improved from 28.50 ms to 22.56 ms in
that run; metadata generation remained comparable at 10.64 ms. Treat these as local comparative
figures rather than cross-machine limits.

The list is virtualized above 200 entries, so these figures isolate the full-list computations that
still occur before rendering. Filtering plus date sorting is currently the most expensive measured
scenario at 100,000 entries and is the first candidate if interactive search becomes visibly slow.

## Resource cleanup audit

The frontend currently has no `URL.createObjectURL` call, so there are no preview object URLs to
revoke. A source audit of global event listeners, timers, `ResizeObserver` instances, and Tauri
subscriptions found matching cleanup paths. This audit should be repeated when a preview feature or
another long-lived subscription is introduced.

The CSS decomposition audit found 356 class names and 564 top-level rules. It found no identical
duplicate rule blocks. Every apparent orphan was either a class assembled at runtime (`state-*`,
`status-*`, `col-*`, `dir-*`, or `log-line-*`) or a class-like word inside a comment, so no selector
was removed on uncertain static evidence.

The audited rules now live behind ordered `workspace.css` and `dialogs.css` facades, split by stable
component ownership without changing selector order. Playwright guards the desktop and narrow
workspace plus Settings and Site Manager dialogs against cascade regressions using the real React
tree and a deterministic in-memory platform API. Run `npm run test:visual`; baseline updates require
the explicit `npm run test:visual:update` command and a visual review.

## Transfer progress renders

Raw `transfer:progress` events update the module-level transfer store. `TransferQueue` is the only
component that consumes the full snapshot, so it renders once per published progress snapshot. The
application composition root consumes `useTransferSummary`; that hook preserves its previous
snapshot reference while the coarse status flags and active count remain equal. Byte-only progress
therefore does not rerender `App` or either file pane. Existing transfer-summary and progress-event
tests cover the status transitions that are allowed to invalidate the coarse snapshot.

The transfer store treats an updater returning the current snapshot as a no-op and does not notify
subscribers. `TransferQueue` memoizes chronological ordering by snapshot identity, so its own
one-second stalled-speed display tick does not repeat the queue sort when transfer data is unchanged.

## Transfer concurrency

Renderer-side folder contents, multi-selection copies, deletes after a move, and operating-system
drops share a concurrency limit of eight operations. This prevents a large top-level selection from
creating an unbounded `Promise.all` fan-out even though nested folder contents were already bounded.
Selected entries are indexed by name once before routing, avoiding repeated linear scans of large
directory listings.

Individual upload/download/copy lifecycle, retry, cancellation, and queue-wide actions live in
`useTransferLifecycle.ts`; recursive walking and local/remote pane routing remain in
`createTransferRouting.ts`. `useOverwriteApproval.ts` owns destination checks and serialized prompts;
`useTransfers.ts` composes these modules with the lifecycle and summary. Transfer IDs use a module-lifetime sequence and check the live store before
allocation, so remounting the application controller cannot overwrite an existing queue row.

## Search, logs and idle work

Site search prepares lowercase searchable text when the site snapshot changes. Each keystroke
then scans that index without rebuilding strings or looking up parents. Search preserves the
original result ordering and site references; replacing a site or parent invalidates the index.
`npm run benchmark:frontend` reports index construction separately from query time.

The log buffer retains at most 500 entries. An oversized batch still consumes an ID per event,
but only retained entries are copied into stamped objects. Empty batches preserve snapshot
identity. IDs are allocated at subscription delivery, so React Strict Mode updater replay cannot
consume extra IDs. The benchmark includes 10,000–100,000-entry incoming batches.

The queue's one-second stalled-speed timer runs only while a row has `progress` status. Paused,
completed and empty queues do not request idle timer renders. Active transfers retain their
existing stalled-speed updates.

Local measurements on 7 September 2026 (median of five warm runs):

| Entries | Build site index | Query prepared index | Append log batch, retain 500 |
| ---: | ---: | ---: | ---: |
| 10,000 | 1.19 ms | 0.42 ms | 0.06 ms |
| 50,000 | 9.69 ms | 1.45 ms | 0.08 ms |
| 100,000 | 16.01 ms | 3.01 ms | 0.14 ms |

These isolate JavaScript computation, exclude rendering and IPC, and are not cross-machine limits.

## Grouped site sorting and byte labels

Automatic Site Manager sorting indexes non-folder entries by parent once. The output
keeps the existing folder order, sibling ordering, root ordering, stable ties and
entry references. Consuming each parent bucket avoids scanning all sites again for
every emitted row. Children are appended individually, avoiding JavaScript's function
argument limit for very large folders. A regression fixture covers 150,000 siblings.

Byte formatting translates only the selected unit instead of translating KB, MB, GB
and TB for every value. Translation still happens at each call, so switching languages
immediately changes labels without maintaining a separate translation cache.

`npm run benchmark:frontend` includes grouped site sorting (100 folders) and byte
formatting at 10,000, 50,000 and 100,000 entries. Local paired measurements on
7 September 2026, using identical inputs and medians of five warm runs:

| Scenario | Before | After |
| --- | ---: | ---: |
| 10,000 sites, name order | 447.30 ms | 1.02 ms |
| 10,000 sites, protocol order | 1,036.17 ms | 1.05 ms |
| 10,000 byte labels | 112.61 ms | 29.16 ms |

The comparison also asserted identical results for both sorting modes and byte labels.
These are computation measurements on this workstation, with other validation work
running concurrently, rather than UI latency guarantees or cross-machine limits.
