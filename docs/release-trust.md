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

The signing secrets are scoped to the GitHub `release` environment. Writing
`environment: release` in the workflow only names that environment; approvals
are a repository setting the workflow cannot see. The `release-environment`
job reads the environment from the GitHub API before the signing job starts
and fails unless it has required reviewers and administrator bypass is off
(`scripts/release/check-release-environment.ts`).

## Provenance

Verify that an installer was built by this repository's release workflow from
a tagged commit:

```powershell
gh attestation verify FTPeach_X.Y.Z_x64-setup.exe -R Smooveemaan/FTPeach
```

The installer is not byte-for-byte reproducible (NSIS and the Rust toolchain
embed build-time data), so provenance is attested, not rebuilt. The SHA-256 of
the installer and the app binary is in the trust report.

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
runners in a private repository, on the exact commit to be tagged, and report
back as the `private-suites` commit status. The release workflow refuses to
publish a tag whose commit lacks a green `private-suites` status. Desktop
checks that take over the screen and the mouse (Explorer drag and drop, file
dialogs, the tray) and the file-system checks on extra drives and shares run on
the maintainer's machine before the release.

### Release matrix

The release trust report copies this table into every draft release. Rows in
the `ci` lane are proven by jobs the release workflow requires; every other row
is printed as NOT VERIFIED until the maintainer records its result in the draft
release's notes. A `manual` row links to its steps.

| Cell | Lane | How |
| --- | --- | --- |
| Default Rust, Node, component and visual suites | ci | `checks.yml` |
| Packaged WebView2 smoke: shutdown flush, editor recovery, vault lock | ci | `packaged-smoke` |
| Portable copy keeps its data beside the program and none in the profile folders | ci | `packaged-smoke`, second run |
| Clean install, upgrade from the previous release, uninstall, the updater, portable update | ci | `installer` |
| Desktop end-to-end, server matrix and protocol compatibility suites | ci | the `private-suites` status of the tagged commit |
| Native desktop checks: Explorer drag and drop, file dialogs, the tray and its notifications | local | run by the maintainer before the release |
| File operations on a second drive, a full drive, exFAT, a share and through links | local | run by the maintainer before the release |
| Clicking the transfer notification brings the window back | manual | [Clicking the transfer notification](manual-checks.md#clicking-the-transfer-notification) |
| Windows Hello unlock | manual | [Windows Hello](manual-checks.md#windows-hello) |
| Windows Hello on a second account | manual | [Windows Hello](manual-checks.md#windows-hello) |
| Vault locks with Windows | manual | [Vault locks with Windows](manual-checks.md#vault-locks-with-windows) |
| Update from the previous published release with the release key, after publishing | manual | [Update from the previous published release](manual-checks.md#update-from-the-previous-published-release) |
