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

## Reproduction

Run npm run check as one invocation. Native smoke uses npm run build:packaged-smoke followed by npm run test:packaged-smoke; see [harness instructions](../scripts/packaged-smoke/README.md). Run cargo deny --manifest-path src-tauri/Cargo.toml check advisories licenses for a fresh dependency check.

For live servers, start docker compose -f src-tauri/tests/docker/docker-compose.yml up --detach, then run powershell -NoProfile -ExecutionPolicy Bypass -File scripts/with-libsodium.ps1 -Command compatibility on Windows. The helper keeps the verified Release CRT library configured for the entire Cargo invocation. Stop those fixture containers after testing. CI also verifies strict TLS endpoint versions before running Rust.

Four default ignored Rust cases are explicit: the external Rebex FTPS test, external SFTP test, external WebDAV test and Windows file-symlink privilege fixture. The Docker target running zero tests without test-utils/--ignored is NOT compatibility coverage. Physical power loss, external-process ancestor races and TPM require separate fixture hardware or manual testing.

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
