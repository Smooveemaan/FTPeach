# What a release proves

A published FTPeach release carries three separate kinds of trust. They are
easy to blur into "the release is signed", so each release run reports them
apart in `release-trust-report.md`, printed in the job summary and attached to
the draft release inside `release-audit.zip`, next to the npm and Cargo SBOMs
(`scripts/release/release-trust-report.ts`).

| Mechanism | Who checks it | Status |
| --- | --- | --- |
| Updater signature (minisign, `.sig`) | The in-app updater, before installing an update | Every `.sig` verified against `plugins.updater.pubkey`; the release fails otherwise. Published inside `latest.json`, not as a separate file |
| Windows Authenticode | Explorer, SmartScreen and UAC on the first download | **Not signed.** Accepted risk, see below |
| Build provenance attestation | Anyone, with `gh attestation verify` | Generated for the NSIS installer and the portable zip by `actions/attest-build-provenance` |
| RustSec exceptions | cargo-deny, `check:rust-advisories` | Listed with kind and review date; see [rust-advisories.md](rust-advisories.md) |

## Authenticode

FTPeach has no code-signing certificate, so the first installer a user
downloads is unsigned and Windows may warn about an unknown publisher. The
updater signature does not change that: Windows never reads it. Once a user
runs a genuine installer, later updates are protected by the updater
signature.

The report accepts `NotSigned` as the known state and says so. It fails the
release for any other outcome that is not a valid, timestamped signature: a
signature that does not verify, or a valid one without a timestamp (it would
stop verifying when the certificate expires). Adding a certificate therefore
needs no change to the gate, only `bundle.windows.certificateThumbprint` (or a
`signCommand`) plus `timestampUrl` in `tauri.conf.json`.

## The release environment

The signing secrets are scoped to the GitHub `release` environment, restricted
to the exact `master` branch. Signing follows successful full public and closed
checks in the same CI chain and needs no separate reviewer approval. PRs,
ordinary pushes and acceptance jobs do not receive the signing key.

The separate `release-tag` environment requires reviewer approval and forbids
administrator bypass. It protects creation of the tag and draft, after automatic
and manual acceptance. A recovered deploy requires a fresh approval. The workflow
reads the actual environment settings from GitHub before proceeding; an environment
name in YAML alone does not prove its protections
(`scripts/release/check-release-environment.ts`).

## Provenance

Verify that an installer was built by this repository's release workflow:

```powershell
gh attestation verify FTPeach_X.Y.Z_x64-setup.exe -R Smooveemaan/FTPeach
```

The installer is not byte-for-byte reproducible (NSIS and the Rust toolchain
embed build-time data), so provenance is attested, not rebuilt. The SHA-256 of
the installer and the app binary is in the trust report.

The release chain pins the application to the commit of its successful
full public and private checks. Sources, dependencies and build scripts stay
on that commit. After building, it checks out the trust report and candidate
manifest tools separately from the commit running the workflow. Fixing those tools therefore
does not require repeating the application's full checks. Changing the
application or its build inputs requires a newly checked source commit.

The candidate manifest identifies both commits and the SHA-256 of every final
file. The manifest step checks the actual application and tool checkouts against
them. GitHub's standard provenance action attests the installer, portable ZIP and
`candidate.json`. Acceptance evidence identifies the exact run and attempt,
verification tools, and manifest hash. Before creating the tag, the finalizer
validates that evidence and the attestations. The manifest is also attached to
the draft, so the application source remains verifiable when it differs from
the workflow commit. The final tag points to the checked application commit,
even if `master` has advanced.

The packages are saved before a separate attestation job contacts GitHub.
If that job fails, retrying it reuses the saved bytes. Acceptance and tag creation
remain blocked until attestation succeeds.

Recovery compares the inputs of each check. A tool correction can verify the
saved packages without rebuilding them or repeating unrelated successful checks.
Changing only the tools commit does not invalidate every result. A missing,
failed, skipped, expired or mismatched result blocks the transition it proves;
an unrelated failed job does not erase successful evidence.

## The updater private key

The report scans the app binary and every file in the bundle directory for
the exact private key the build was given, its decoded form and minisign
secret-key headers, and fails on any hit. The installer itself is compressed,
so its own bytes are not scanned; its inputs are.

To rotate the updater key: generate a new pair
([updater-signing.md](updater-signing.md)), ship one release that is still
signed with the old key but carries the new `plugins.updater.pubkey`, then
replace the environment secrets. Installations that skip that release cannot
verify later updates and need a manual reinstall. If the old key leaks, there
is no safe in-band rotation: publish the new build as a manual download.

## WebView2 runtime

The installer uses Tauri's default WebView2 mode: when the runtime is missing
it downloads Microsoft's Evergreen bootstrapper over HTTPS from Microsoft. The
bootstrapper is Microsoft-signed and FTPeach does not ship or pin it. Runtime
servicing is separate from FTPeach's release artifacts.

## RSA and dependency upgrades

RSA SSH keys go through `rsa`, which has an open timing advisory
(RUSTSEC-2023-0071). Ed25519 is recommended and the app warns when an RSA key
is selected; the reachable signing path and why it is kept are recorded in
[rust-advisories.md](rust-advisories.md). The weekly audit fails if the
register's kind for an advisory disagrees with RustSec's.

Dependabot proposes updates but does not merge them. Every release also runs
the protocol compatibility suite against real servers, so a protocol crate
update cannot ship on unit tests alone ([dependency-policy.md](dependency-policy.md)).

## How releases are verified

Besides the tests in this repository, every release is checked by suites the
maintainer keeps closed: end-to-end tests that drive the built application,
the client against a matrix of real FTP, FTPS, SFTP and WebDAV servers, and
protocol round trips against servers in Docker. They run on GitHub-hosted
runners in a private repository, on the exact commit to be tagged. The release
chain validates the specific private run, attempt, test-source SHA and mandatory
results against its public parent run. A commit status alone cannot authorize a
release. Private sources and logs remain in the private repository. Desktop
checks that take over the screen and the mouse (Explorer drag and drop, file
dialogs, the tray) and the file-system checks on extra drives and shares run on
the maintainer's machine before the release.

### Release and recovery

A `master` push whose last commit contains the exact standalone line
`Release-Check: true` starts the full public and closed checks. Their success
continues through Windows x64 NSIS and portable packaging, signing, artifact
retention, attestation and final-package acceptance in one CI chain. The
`manual-acceptance` stage requires separate attestation and package-test results.
The diagnostic Installer workflow retains its test-key negative scenarios.
Unix source checks remain part of the full suite; this release's packaging and
package acceptance run only on Windows.

The owner records required manual acceptance for the exact application SHA and
manifest SHA-256. In `release.yml`, operation `record-manual` accepts the
`candidate-id` (`RUN_ID:BUILD_ATTEMPT`) and `manual-acceptance` JSON. It records the
tester, date, and each mandatory result with evidence. A skipped or unperformed
check does not pass. The normal chain waits for that record before requesting
the `release-tag` deploy approval.

After approval, readiness is checked again. The workflow creates an annotated
tag on the application SHA and a draft containing the accepted files and update
feed. Existing tags and assets must match; recovery adds missing assets without
replacing them. The workflow downloads the draft assets and verifies their
completeness and hashes before declaring the draft ready. The owner publishes
it. Public package and feed availability, Pages, and a real update from the
public feed are checked after publication. Tags do not start another build or CI.

For an interrupted candidate, dispatch `release.yml` on trusted `master` with
operation `resume` and its `candidate-id`. The workflow determines which evidence
is missing or stale; the operator does not select a stage. A repeated Installer
run reports its reason and requires separate permission through
`installer-approved`. Operation `deploy` resumes an accepted candidate's tag and
draft preparation and always requires a new protected approval.

If application or build inputs change, the new candidate needs its own package
acceptance. If saved packages expire before tagging, create a new candidate;
after tagging, recover the original files. A new build cannot replace a tagged
release. An unsafe published version is corrected with a new release.

The ordinary Windows path and recovery still require live acceptance of this
workflow change; the workflow definition alone is not proof that either passed.

### Release matrix

The release trust report copies this table into every draft release. Rows in
the `ci` lane are proven by jobs the release workflow requires; every other row
is printed as NOT VERIFIED until the maintainer records its result for the exact
candidate. Required pre-publication results are checked before deploy; the public-feed
update check follows publication. A `manual` row links to its steps.

| Cell | Lane | How |
| --- | --- | --- |
| Default Rust, Node, component and visual suites | ci | `checks.yml` |
| Packaged native smoke on Windows, macOS and Linux: shutdown flush, editor recovery, vault lock | ci | `packaged-smoke` matrix |
| Portable Windows copy keeps its data beside the program and none in the profile folders | ci | `packaged-smoke`, second run on Windows |
| Clean install, upgrade from the previous release, uninstall, the updater, portable update | ci | `installer` |
| Desktop end-to-end, server matrix and protocol compatibility suites | ci | the private run and receipt bound to the release CI and application SHA |
| Native desktop checks: Explorer drag and drop, file dialogs, the tray and its notifications | local | run by the maintainer before the release |
| File operations on a second drive, a full drive, exFAT, a share and through links | local | run by the maintainer before the release |
| Clicking the transfer notification brings the window back | manual | [Clicking the transfer notification](manual-checks.md#clicking-the-transfer-notification) |
| Windows Hello unlock | manual | [Windows Hello](manual-checks.md#windows-hello) |
| Windows Hello on a second account | manual | [Windows Hello](manual-checks.md#windows-hello) |
| Vault locks with Windows | manual | [Vault locks with Windows](manual-checks.md#vault-locks-with-windows) |
| Update from the previous published release with the release key, after publishing | manual | [Update from the previous published release](manual-checks.md#update-from-the-previous-published-release) |
