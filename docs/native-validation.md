# Native and dependency validation

## Release gates

The release workflow requires both the shared checks (including packaged smoke and cargo deny) and the reusable protocol compatibility workflow before publishing. Compatibility runs the ignored Docker integration target explicitly; it publishes result counts or a NOT RUN reason in the job summary. Full stdout, including ignored/skipped counts, remains in CI job logs. A setup failure is not a pass.

| Layer | What it proves | What remains outside it |
| --- | --- | --- |
| Playwright visual harness | Renderer interactions, translated sizing and screenshots using mock API | Tauri ACL, native shell and real protocol I/O |
| Packaged smoke feature | Real WebView2/dist process, backend settings/vault/basic local-copy probes, dialogs, RTL and contrast | Production installer/update installation, complete ACL matrix, Explorer, native drag, Windows Hello/TPM |
| Local protocol fixtures | Controlled stalls, status errors, cancellation, byte budgets | Third-party server behavior |
| Docker compatibility | Explicit ignored tests against disposable FTP/FTPS/SFTP/WebDAV and TLS endpoints | Every server/version, external network failures or power loss |
| cargo deny | Current advisory database and license policy for the locked graph | Proof of absence of exploitable bugs; ignored advisories remain accepted risks |

## HF-24 verification run, Windows, 2026-09-23

The lanes, ignored tests and release matrix are in
[verification-matrix.md](verification-matrix.md), which records each result.
This run found two regressions only real servers could show, both in
unpushed commits: FTP login sent `PASS [REDACTED]` (the password became a
`SensitiveString` with a redacting `Display`), and the matrix and Docker
suites could not reach SFTP or http:// WebDAV once an unconfirmed host key
and cleartext sign-in were refused by default. The first is fixed and caught
by the local FTP fixtures; the suites now opt into both explicitly and assert
the refusing default.

Server matrix: 616 passed, including IIS. Docker compatibility: 14 and 2
passed. Rebex FTPS/SFTP and the cross-volume move passed. NOT RUN: the
symlink fixture (privilege not held), IPv6 loopback (EACCES on this host) and
the external WebDAV test (no server). Evidence: `.local/hf24-*.log`.

## P1 hotfix completion, Windows, 2026-09-23

This is the current HF hotfix queue (19 P1 items, including HF-54), not the
older A06-A18 audit in transfer-safety.md. The implementation revision is
`0c9fc61`; P0 completion remains recorded separately below.

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
| HF-04 | `8d23084` | Real TCP FTP fixture: existing bytes and a file arriving after listing survive; unsupported creation leaves no artifacts |
| HF-07 | `f061d1c`, `ea077bd`, `25068be` | Revision queue, A/B/C edits, edits during upload, failure/retry, disconnect and native recovery |
| HF-05 | `e9f10a3` | Per-item batch results, retained originals and cut clipboard behavior |
| HF-06 | `5712c79` | Deferred worker barrier and bounded batch admission |
| HF-11 | `75d3bd2` | Real tabs API adapter with failed envelope, rejected promise and ordered snapshots |
| HF-12 | `9ff8e1a` | Settings/tabs flush, delayed writes, disabled session saving, stale acknowledgements, renderer timeout and packaged WebView2 shutdown |
| HF-15 | `8983cb7` | 10,000-record stalled-writer test, drop notice and recovery, byte/entry budgets, delayed renderer history, log flush |
| HF-22 | `fdb8668` | CI classifier recognizes frontend JSON compiled into Rust |
| HF-54 | `5712c79`, `75d3bd2`, `e9f10a3` | Batch/persistence reproductions run in the normal unit/component suites |

HF-04 closes with an explicit functional restriction: New file on FTP/FTPS
returns `createUnsupported` when the requested name is free, because the adapter
has no exclusive publication capability. It never sends STOR/RNTO for this
operation. Existing targets return `alreadyExists`; SFTP/WebDAV creation remains
available. This is distinct from the accepted FTP rename race in HF-02.

The packaged smoke adds a tab and changes pane orientation, then immediately
enters the real `wind_down` shared by quit and immediate update installation.
It requires a successful renderer flush acknowledgement and rereads both JSON
files, as well as verifying editor recovery and vault locking. It does not launch
an installer. A crashed/unresponsive renderer has a bounded fallback with a log
diagnostic, not a guarantee of preserving changes it never sent.

Full `npm run check`: PASS in one invocation, exit 0, on `0c9fc61`.
301 Node unit tests, 361 component tests, 65 browser tests, 504 Rust library
tests, four Rust example tests and 22 parser regression tests passed. The same
invocation passed lint/TypeScript, formatting, source policies, localization,
licenses, Clippy, production build/bundle checks and valid/damaged updater
fixtures. Packaged native build and smoke passed separately.

Evidence: `.local/p1-completion-check.log`, `.local/p1-smoke-build.log`,
`.local/p1-smoke.log`. Nine Rust tests remain ignored in the default suite;
they are not passes. Docker compatibility, external server matrix, privileged
Windows fixtures, fresh cargo deny and production installation were not rerun
for this completion; their separate release requirements remain in force.

## P0 completion checks, Windows, 2026-09-22

- Rust: 454 library tests and four example tests passed; nine remain ignored by default.
- The explicit `cross_volume_disk_move` fixture passed between C: and D:, including
  no-replace collision and approved overwrite. The fixture first verifies error 17 from
  an ordinary rename to prove it is really exercising two volumes.
- Native recovery tests hold editor handles with and without delete sharing, and with
  exclusive access. Late saves survive shutdown even when the copy was initially clean.
- Packaged WebView2 smoke verifies edited-copy recovery and vault locking through the real
  `shutdown::wind_down` shared by quit and immediate update installation. It does not launch
  a production installer. Smoke storage explicitly uses its isolated LOCALAPPDATA because
  Windows KnownFolder resolution can ignore the process environment override.
- The rename scenario passed on IIS FTP, FTP with Unix listings, FTPS and WebDAV. The
  matrix output also contains 29 NOT RUN profiles; they are not server coverage.
- Unit/component tests, lint/TypeScript, Clippy and production build/bundle checks passed.

Evidence: `.local/p0-completion-*.log`, `.local/p0-cross-volume.log`,
`.local/p0-iis-rename.log`, `.local/p0-smoke*.log`. HF-02 was closed with an explicitly
accepted FTP limitation: rename to an apparently free name proceeds without an overwrite
prompt; a detected conflict requires confirmation. The check-then-rename race with another
client remains possible. Passing these tests does not prove atomic no-replace on FTP.

## Reproduction

Run npm run check as one invocation. Native smoke uses npm run build:packaged-smoke followed by npm run test:packaged-smoke; see [harness instructions](../scripts/packaged-smoke/README.md). Run cargo deny --manifest-path src-tauri/Cargo.toml check advisories licenses for a fresh dependency check.

For live servers, start docker compose -f src-tauri/tests/docker/docker-compose.yml up --detach, then run powershell -NoProfile -ExecutionPolicy Bypass -File scripts/with-libsodium.ps1 -Command compatibility on Windows. The helper keeps the verified Release CRT library configured for the entire Cargo invocation. Stop those fixture containers after testing. CI also verifies strict TLS endpoint versions before running Rust.

Every ignored Rust test, with what it needs and the command that runs it, is listed in [verification-matrix.md](verification-matrix.md). The Docker target running zero tests without test-utils/--ignored is NOT compatibility coverage. Physical power loss, external-process ancestor races and TPM require separate fixture hardware or manual testing.

## P3 run, Windows, 2026-09-07

Fresh cargo deny: advisories ok, licenses ok with eight documented exceptions. Dependency paths were captured with cargo tree --locked -i for rsa, paste, unic-char-range and bincode@1.3.3. Local logs use .local/logs/p3-*.log. The full check result is recorded below.

The site-manager screenshot was inspected as expected/actual: the sort trigger changes from a fixed width to the translated option width, consistent with the existing English/Russian geometry test. The reviewed baseline was updated; the geometry test still checks stable width after selection and matching dropdown width.

| P3 acceptance run | Result | Local evidence |
| --- | --- | --- |
| Packaged native build and smoke | PASS: real WebView2 process exits successfully after checks | p3-smoke-build.log, p3-smoke.log |
| Docker compatibility | PASS: 12 passed, zero failed/ignored | p3-compatibility.log |
| Strict TLS endpoints | PASS: each accepts its configured version and rejects the other | p3-tls-endpoints.log |
| Windows file-symlink artifact | PASS: explicit ignored fixture preserves target bytes | p3-symlink.log |
| Protected public commands with required UNC | PASS with FTPEACH_REQUIRE_UNC_FIXTURES=1 | p3-unc.log |
| Fresh advisories/licenses | PASS with eight unchanged exceptions | p3-cargo-deny.log |

The additional Windows fixtures used the existing test binary built from the unchanged safety modules. The default suite still reports four ignored tests; the symlink case was separately executed, while the three public-server tests were not. Real-server resume fixtures now preserve deliberately incorrect legacy partial bytes and verify that cancellation/resume consumes the owned UUID artifact and requests the missing HTTP range. Per-run remote resume directories prevent a failed earlier run from poisoning later SFTP mkdir checks.

Full npm run check: PASS in one invocation, exit 0. 191 Node tests, 103 component tests, eight visual tests and 239 Rust tests passed; four Rust cases were ignored in the default invocation as detailed above. Lint/TypeScript, formatting, source policies, Clippy, production build/bundle budget and valid/damaged updater fixtures passed. Evidence: .local/logs/p3-check.log.
