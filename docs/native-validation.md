# Native and dependency validation

The packaged smoke reads the Windows WebView2 controller to verify rasterization
scale 1, disabled automatic rasterization changes, and page zoom equal to monitor
DPI times the latest user preference. Unit tests reject invalid zoom requests;
component tests ensure the renderer does not multiply by its own (already zoomed)
devicePixelRatio. Physical moves between monitors and transient resize bands still
require manual verification, including the original frame/shadow and UI scales
80%, 100%, 125% and 150%. No screenshot can prove the absence of a brief flash.

## Release gates

The release workflow requires both the shared checks (including packaged smoke and cargo deny) and the reusable protocol compatibility workflow before publishing. Compatibility runs the ignored Docker integration target explicitly; it publishes result counts or a NOT RUN reason in the job summary. Full stdout, including ignored/skipped counts, remains in CI job logs. A setup failure is not a pass.

| Layer | What it proves | What remains outside it |
| --- | --- | --- |
| Playwright visual harness | Renderer interactions, translated sizing and screenshots using mock API | Tauri ACL, native shell and real protocol I/O |
| Packaged smoke feature | Real WebView2/dist process, backend settings/vault/basic local-copy probes, dialogs, RTL and contrast | Production installer/update installation, complete ACL matrix, Explorer, native drag, Windows Hello/TPM |
| Local protocol fixtures | Controlled stalls, status errors, cancellation, byte budgets | Third-party server behavior |
| Docker compatibility | Explicit ignored tests against disposable FTP/FTPS/SFTP/WebDAV and TLS endpoints | Every server/version, external network failures or power loss |
| [Server matrix](test-server-matrix.md) | Weekly and on demand: about thirty server implementations and configurations, IIS, SOCKS/HTTP proxies, relays between servers and Toxiproxy faults (latency, drops, a silent server) | Not a release gate; active-mode FTP only on Linux runners; real WAN conditions |
| cargo deny | Current advisory database and license policy for the locked graph | Proof of absence of exploitable bugs; ignored advisories remain accepted risks |

## Recorded runs

Each row is what one Windows run proved on that date; counts are not updated
afterwards. Evidence logs stay in the maintainer's `.local/` folder. NOT RUN
means the check did not execute, never that it passed. Per-test results for the
ignored suites are in [verification-matrix.md](verification-matrix.md).

| Date | Scope | Passed | NOT RUN |
| --- | --- | --- | --- |
| 2026-09-24 | `npm run check` on `2a68b2c` before the next release; fresh `npm audit` and `cargo deny` | 350 Node, 488 component, 73 browser, 586 Rust library, 4 example and 22 parser tests; lint, formatting, policies, localization, licenses, duplication, coverage floors, Clippy, bundle budget, updater fixtures; no npm advisories, cargo deny clean; Semgrep 0 findings; Docker compatibility 14 and 2 | Server matrix, packaged smoke, privileged Windows fixtures |
| 2026-09-23 | HF-24 verification | Server matrix 616 including IIS; Docker compatibility 14 and 2; Rebex FTPS/SFTP; cross-volume move | Symlink fixture (privilege not held), IPv6 loopback (EACCES), external WebDAV (no server) |
| 2026-09-23 | P1 hotfix completion on `0c9fc61` | `npm run check`: 301 Node, 361 component, 65 browser, 504 Rust library, 4 example and 22 parser tests; packaged build and smoke | Docker compatibility, server matrix, privileged fixtures, cargo deny, production installation |
| 2026-09-22 | P0 completion | Rust suites; `cross_volume_disk_move` C: to D:; editor-handle recovery; packaged smoke through `shutdown::wind_down`; rename on IIS FTP, Unix-listing FTP, FTPS and WebDAV | 29 server-matrix profiles |
| 2026-09-07 | P3 acceptance | Packaged build and smoke; Docker compatibility 12; strict TLS endpoints; symlink fixture; UNC public commands with `FTPEACH_REQUIRE_UNC_FIXTURES=1`; cargo deny with eight documented exceptions | — |

The HF-24 run found two regressions only real servers could show: FTP login
sent `PASS [REDACTED]` once the password became a `SensitiveString`, and the
matrix and Docker suites could not reach SFTP or `http://` WebDAV once an
unconfirmed host key and cleartext sign-in were refused by default. Both are
fixed; the local FTP fixtures now catch the first, and the suites opt into both
explicitly and assert the refusing default.

## Hotfix traceability

| Item | Implementation commits | Regression evidence |
| --- | --- | --- |
| HF-36, HF-37 | `0b4665d` | Final executable-name classification and bound Open-with intents; security tests |
| HF-38 | `a7cebc9` | Separate security confirmation and rejected unprivileged weakening |
| HF-39 | `76e79c4` | Saved-secret recipient binding and credential-scope tests |
| HF-40 | `7a900d8` | Master-password reauthentication before disabling enhanced protection |
| HF-41 | `c1d9bf5` | Backup secret removal and storage failure/recovery tests |
| HF-42 | `89a5784`, `0c9fc61` | Bounded FTP/FTPS/encoding-relay replies and active peers; standalone fuzz workspace uses the same patched reader |
| HF-43 | `7a0a615` | Held updater object, path substitution and rollback fixtures; no installer launched |
| HF-09, HF-10 | `66ed95e` | Failed encryption retains prior secret; delayed reveal cannot overwrite a different site or newer input |
| HF-04 | `8d23084`, `afd4455` | Real TCP FTP fixture: existing bytes and a file arriving after the check survive an empty `APPE`; a refused `APPE` stores nothing |
| HF-07 | `f061d1c`, `ea077bd`, `25068be` | Revision queue, A/B/C edits, edits during upload, failure/retry, disconnect and native recovery |
| HF-05 | `e9f10a3` | Per-item batch results, retained originals and cut clipboard behavior |
| HF-06 | `5712c79` | Deferred worker barrier and bounded batch admission |
| HF-11 | `75d3bd2` | Real tabs API adapter with failed envelope, rejected promise and ordered snapshots |
| HF-12 | `9ff8e1a` | Settings/tabs flush, delayed writes, disabled session saving, stale acknowledgements, renderer timeout and packaged WebView2 shutdown |
| HF-15 | `8983cb7` | 10,000-record stalled-writer test, drop notice and recovery, byte/entry budgets, delayed renderer history, log flush |
| HF-22 | `fdb8668` | CI classifier recognizes frontend JSON compiled into Rust |
| HF-54 | `5712c79`, `75d3bd2`, `e9f10a3` | Batch/persistence reproductions run in the normal unit/component suites |

Two items closed with a recorded protocol limit. HF-02: FTP rename to an
apparently free name proceeds without an overwrite prompt and a detected
conflict requires confirmation, but another client can still create the target
between the check and RNTO. HF-04: New file on FTP/FTPS sends an empty `APPE`,
so a file that arrives after the check keeps its content, but success does not
prove the file is new, and a server answering 502/504 yields `createUnsupported`.
There is never a STOR fallback.

The packaged smoke adds a tab and changes pane orientation, then immediately
enters the real `wind_down` shared by quit and immediate update installation.
It requires a successful renderer flush acknowledgement and rereads both JSON
files, as well as verifying editor recovery and vault locking. It does not launch
an installer. A crashed/unresponsive renderer has a bounded fallback with a log
diagnostic, not a guarantee of preserving changes it never sent.

## Reproduction

The Windows regression test
`runtime::window_resize::tests::container_matches_client_before_downstream_size_handler`
resizes hidden native windows and checks the child bounds inside the downstream
`WM_SIZE` handler. It verifies message ordering, not WebView2/DWM presentation.
Visible resize artifacts still require a manual run, including rapid expansion
and contraction, maximize/restore, and light/dark themes.

Run `npm run check` as one invocation. Native smoke uses `npm run build:packaged-smoke` followed by `npm run test:packaged-smoke`; see [harness instructions](../scripts/packaged-smoke/README.md). Run `cargo deny --manifest-path src-tauri/Cargo.toml check advisories licenses` for a fresh dependency check.

For live servers, start `docker compose -f src-tauri/tests/docker/docker-compose.yml up --detach`, then run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/with-libsodium.ps1 -Command compatibility` on Windows. The helper keeps the verified Release CRT library configured for the entire Cargo invocation. Stop those fixture containers after testing. CI also verifies strict TLS endpoint versions before running Rust.

Every ignored Rust test, with what it needs and the command that runs it, is listed in [verification-matrix.md](verification-matrix.md). The Docker target running zero tests without test-utils/--ignored is NOT compatibility coverage. Physical power loss, external-process ancestor races and TPM require separate fixture hardware or manual testing.
