# What a release proves

A published FTPeach release carries separate kinds of trust. They are easy to
blur into "the release is signed", so each release run reports them apart in
`release-trust-report.md`, printed in the job summary and attached to the draft
release inside `release-audit.zip`, next to the npm and Cargo SBOMs
(`scripts/release/release-trust-report.ts`).

| Mechanism | Who checks it | Status |
| --- | --- | --- |
| Updater signature (minisign, `.sig`) | The in-app updater, before installing an update | Every `.sig` verified against `plugins.updater.pubkey`; the release fails otherwise. Published inside `latest.json`, not as a separate file |
| Windows Authenticode | Explorer, SmartScreen and UAC on the first download | **Not signed** on direct downloads (accepted risk, see below); Microsoft Store MSIX builds are signed by Microsoft Partner Center |
| macOS Developer ID & Notarization | Gatekeeper (`codesign`, `spctl`, `stapler`) | Signed with Developer ID Application, notarized via `notarytool`, and stapled (`>= 0.7.0`) |
| Build provenance attestation | Anyone, with `gh attestation verify` | Generated during the build jobs for `candidate.json` and the release packages by `actions/attest-build-provenance` |
| RustSec exceptions | cargo-deny, `check:rust-advisories` | Listed with kind and review date; see [rust-advisories.md](rust-advisories.md) |

## Authenticode

FTPeach has no Windows Authenticode certificate for direct GitHub downloads, so
the first NSIS installer or portable archive a user downloads is unsigned and
Windows may warn about an unknown publisher. The updater signature does not
change that: Windows never reads it. Once a user runs a genuine copy, later
updates are protected by the updater signature. Microsoft Store builds (`*.msix`
from `>= 0.7.0`) disable the in-app updater and portable mode at compile time
(`--features ms-store`) and are signed and updated by the Microsoft Store.

The report accepts `NotSigned` as the known state and says so. It fails the
release for any other outcome that is not a valid, timestamped signature: a
signature that does not verify, or a valid one without a timestamp (it would
stop verifying when the certificate expires). Adding a certificate therefore
needs no change to the gate, only `bundle.windows.certificateThumbprint` (or a
`signCommand`) plus `timestampUrl` in `tauri.conf.json`.

## macOS Developer ID and Notarization

Starting with `0.7.0`, macOS builds are signed with Apple Developer ID
Application certificates, notarized via Apple's notary service (`notarytool`),
and stapled for offline Gatekeeper verification. Universal packages
(`universal-apple-darwin`) bundle both `arm64` and `x86_64` slices.

Hardened runtime is enabled by default. To support moving items to Trash via
Finder AppleScript (task A-5), `Entitlements.plist` declares
`com.apple.security.automation.apple-events`, and `Info.plist` declares
`NSAppleEventsUsageDescription`.

## The release environment

The signing secrets are scoped to the GitHub `release` environment, restricted
to the exact `master` branch. Signing follows successful full public and closed
checks in the same CI chain and needs no separate reviewer approval. PRs,
ordinary pushes and acceptance jobs do not receive the signing key.

The separate `release-tag` environment requires reviewer approval and forbids
administrator bypass. It protects creation of the tag and draft directly after
automatic candidate acceptance succeeds. A recovered deploy requires a fresh
approval. The workflow reads the actual environment settings from GitHub before
proceeding; an environment name in YAML alone does not prove its protections
(`scripts/release/check-release-environment.ts`).

Tag creation uses a repository deploy key stored only in the `release-tag`
environment as `RELEASE_TAG_KEY`. Its private key becomes available after approval
and is removed from the runner when the tag job exits. The creation ruleset for
`v*` tags permits deploy keys; a separate ruleset still restricts updates and
deletions to repository administrators. Only the release deploy key should have
write access. The workflow pushes one annotated tag without force, with GitHub's
SSH host key pinned. Drafts and assets use the job's ordinary `GITHUB_TOKEN`.

## Provenance

Verify that a release package was built by this repository's release workflow:

```powershell
gh attestation verify FTPeach_X.Y.Z_x64-setup.exe -R Smooveemaan/FTPeach
```

The packages are not byte-for-byte reproducible (NSIS, linker metadata and the
Rust toolchain embed build-time data), so provenance is attested, not rebuilt.
The SHA-256 of every release artifact is recorded in the trust report and bound
in `candidate.json`.

The release chain runs on the exact commit of its successful full public and
private checks. `candidate.json` records the application SHA, workflow SHA,
toolchain versions, and the SHA-256 of every final file across all built
platforms. GitHub's standard provenance action attests the built packages and
`candidate.json` directly at the end of the build jobs. Acceptance evidence
(`candidate-<id>-acceptance`, `candidate-<id>-acceptance-macos`,
`candidate-<id>-acceptance-linux`) binds directly to the immutable `candidateId`
and `candidateHash`. Before creating the tag, `finalize.ts` validates that
evidence and verifies the provenance attestations. `candidate.json` remains
inside the retained Actions artifact (`release-candidate-<attempt>`) and is not
attached to the public GitHub Release; the annotated release tag `vX.Y.Z`
embeds `FTPeach candidate SHA256: <hash>` and points to the checked application
commit.

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
protocol round trips against servers in Docker. They run in a closed verification
environment on the exact commit to be tagged. The release chain runs directly
after `mode`, `checks` and `private-check` succeed in `ci.yml`. Private sources
and logs remain in the private repository.

### Release and recovery

A `master` push whose last commit contains the exact standalone line
`Release-Check: true` starts the full public and closed checks. Their success
continues directly into `release.yml`:
- For `0.6.x`, `build-windows` builds and signs the Windows x64 NSIS and
  portable packages and attests them, followed by `acceptance` on
  `windows-latest` (running `portable`, `shell`, `notification` and full
  installer/updater scenarios on the saved candidate bytes).
- Starting with `0.7.0`, `build-macos` (`macos-15`), `build-linux`
  (`ubuntu-22.04`) and `build-windows` (`windows-latest`, including Microsoft
  Store MSIX) build, sign and attest all target packages into a single unified
  `release-candidate` artifact, followed in parallel by `acceptance`
  (`windows-latest`), `acceptance-macos` (`macos-15`) and `acceptance-linux`
  (`ubuntu-22.04`).

Once automatic acceptance succeeds, `tag-and-draft` automatically pauses in
`Waiting` on the protected `release-tag` environment. There is no manual-check
JSON upload or polling loop in CI; local manual checks (`docs/manual-checks.md`)
are performed only when changes touch those specific areas.

After the owner approves `release-tag`, `finalize.ts` revalidates the candidate
and acceptance evidence, creates the annotated tag `vX.Y.Z`, creates the draft
release with clean `release-notes.md` text, uploads only user-facing assets and
`latest.json` (verifying SHA-256 digests directly from the GitHub API response),
and leaves the draft ready for publication. After the owner publishes the draft,
`release-published.yml` verifies the public assets, `latest.json`, Ed25519
updater signatures and Pages on `ubuntu-latest`, and runs real public-feed
updates on `windows-latest`.

For an interrupted candidate, dispatch `release.yml` on trusted `master` with
operation `resume` and its `candidate-id` to rerun missing automatic acceptance
on the saved candidate bytes without rebuilding, or operation `deploy` to run
`tag-and-draft` (with a fresh `release-tag` approval) when automatic acceptance
is already complete. Repeating Windows `installer` acceptance requires
`installer-approved: true` after owner permission.

### Release matrix

The release trust report includes this table in `release-audit.zip`. Rows in
the `ci` lane are proven by jobs the release workflow requires; every other row
is printed as NOT VERIFIED by the automated workflow and describes change-triggered
local checks or post-publication automation.

| Cell | Lane | How |
| --- | --- | --- |
| Default Rust, Node, component and visual suites | ci | `checks.yml` |
| Packaged native smoke on Windows, macOS and Linux: shutdown flush, editor recovery, vault lock | ci | `packaged-smoke` matrix |
| Portable Windows copy keeps its data beside the program and none in the profile folders | ci | `packaged-smoke`, second run on Windows |
| Clean install, upgrade from the previous release, uninstall, the updater, portable update | ci | `installer` |
| Desktop end-to-end, server matrix and protocol compatibility suites | ci | the private run bound to the release CI and application SHA |
| Portable isolation, Windows shell actions and notification click | ci | `acceptance` (`installer.yml`) on the saved candidate packages |
| macOS universal signature, notarization, DMG mount, dual-slice launch and updater archive (`>= 0.7.0`) | ci | `acceptance-macos` on the saved candidate packages |
| Linux Debian install, AppImage launch and updater signatures under Xvfb + D-Bus (`>= 0.7.0`) | ci | `acceptance-linux` on the saved candidate packages |
| File operations on a second drive, a full drive, exFAT, a share and through links | local | on relevant filesystem changes |
| Windows Hello unlock | local | on relevant changes; [Windows Hello](manual-checks.md#windows-hello) |
| Windows Hello on a second account | local | on relevant changes; [Windows Hello](manual-checks.md#windows-hello) |
| Vault locks with Windows | local | on relevant changes; [Vault locks with Windows](manual-checks.md#vault-locks-with-windows) |
| Update from the previous published release with the release key, after publishing | local | required independent post-publication automation; [Update from the previous published release](manual-checks.md#update-from-the-previous-published-release) |
