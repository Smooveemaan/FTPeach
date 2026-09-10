# FTPeach threat model

This document describes the trust boundaries and defensive decisions of the current FTPeach desktop client. It is an engineering threat model, not a promise of absolute security or a release guide.

## Scope

The model covers the React/WebView renderer, Tauri IPC commands, the Rust backend, the local Windows filesystem, `%APPDATA%\FTPeach`, remote FTP/FTPS/SFTP/WebDAV servers, the updater endpoint, and applications that receive files through **Open with**.

The security of Windows and the user's account, vulnerabilities in WebView2 or an external editor after it receives a file, and compromise of the FTPeach process with full memory access are outside the model.

## Protected data

- saved passwords and SSH-key passphrases;
- private SSH keys and their paths;
- local and remote file contents;
- saved sites, settings, and SFTP host-key fingerprints;
- updater artifacts and application code;
- diagnostic and protocol logs.

## Trust boundaries

### Renderer and Tauri/Rust

The renderer is less trusted, but it is not a sandboxed security principal. `default.json` grants the main window only required event/window `allow-*` permissions; updater, dialog, notification, and opener capabilities are exposed through narrow Rust commands rather than directly to JavaScript. Ordinary browsing, connection, transfer, and settings commands remain available to the main renderer and validate their inputs in Rust.

Sensitive file, reset, secret-reveal, and import/export operations are registered in the `sensitive` Tauri plugin and are available only to the `main` window through explicit permissions. Every call requires a 30-second, one-use token bound to the requesting window, exact operation, and canonical path or logical target. The backend itself opens a separate confirmation window for secret reveal, vault reset, and executable content when required. Delete, reveal-in-Explorer, ordinary document open, and import/export do not always show a backend confirmation; a compromise of the authorized main renderer can request their tokens. Canonical paths, protected targets, native-dialog provenance, and reparse-point checks remain enforced in Rust.

The production CSP is defined only in `tauri.conf.json`. Scripts are restricted to `self`, without `unsafe-eval` or external script sources. `npm run check:release-config` rejects broad `*:default` permissions, a duplicate HTML CSP, or a weakened script policy.

`sites_list` does not return saved passwords. The renderer sees only `hasPassword` and `hasKeyPassphrase` and supplies a `siteId` when connecting. The backend loads the associated configuration, preventing the renderer from redirecting one site's password to an arbitrary host.

Normal listing and editing IPC returns only presence flags. An explicit reveal uses a short-lived one-use token; Stronghold additionally requires master-password reauthentication before that token is issued. The renderer clears a revealed value on blur, hide, vault lock, dialog close, and unmount.

### Rust and the local filesystem

FTPeach is intentionally a full local file manager, so it does not impose a selected-folder allowlist. Destructive commands canonicalize paths in the backend and reject drive roots, the user profile, the application directory, `%APPDATA%\FTPeach`, and their parents.

Recursive deletion does not use `remove_dir_all`. It walks bottom-up and rejects symlinks, junctions, and all Windows reparse points. Checks are repeated before every deletion and retry. A narrow TOCTOU risk remains against a local process that can replace filesystem entries concurrently.

### Rust and remote servers

Remote listing names are untrusted. Empty names, `.` and `..`, and names containing path separators are rejected before reaching UI or path operations. WebDAV URLs use percent-encoded segments. Recursive FTP and SFTP operations have depth limits.

FTPS and WebDAV verify TLS certificates by default. SFTP uses TOFU: the first fingerprint is stored in `known_hosts.json`, and a changed key blocks the connection until the user explicitly approves it.

### Updater endpoint and application

The production endpoint must use HTTPS, cannot target loopback, and is checked automatically. Tauri also verifies artifact signatures with the configured public key. The private signing key must never be included in the repository or user builds.

A downloaded update waits in `%LOCALAPPDATA%\com.smooveemaan.ftpeach\updates` until the next launch or an explicit **Install update**. The installer is verified against the same public key again immediately before it runs, so a file changed or truncated on disk is discarded rather than executed. An install that does not complete is not retried from the same download, so a broken installer cannot turn every launch into another failed install.

### FTPeach and external applications

**Open with** downloads an untrusted remote file to a temporary directory and passes it to the Windows-registered application. FTPeach removes its temporary copies on a best-effort basis but cannot control editor vulnerabilities, recent-file history, backups, or cloud synchronization. A file modified by the external application may be offered for upload to the server.

## Stronghold and the master password

Saved site passwords and private SSH-key passphrases are stored in `%APPDATA%\FTPeach\vault.hold`. After migration, `sites.json` contains only non-secret parameters and `hasPassword`/`hasKeyPassphrase` flags. The renderer supplies only `siteId`; the Rust backend resolves the secret.

Setup creates a random 32-byte data key. Stronghold encrypts the snapshot with this key, while Argon2id derives the key that wraps it from the master password. `vault.json` stores the format version, unique salt, and KDF parameters, but never the master password or data key. Current production parameters are Argon2id v1, 64 MiB of memory, three passes, and one lane. Changing the master password rewraps the data key without re-encrypting every secret.

All KDF and protected vault transitions share one process-wide semaphore. Failed authentication uses exponential backoff from 500 ms to 30 seconds and is limited to eight failures in a rolling five-minute window. Successful authentication or a completed safe reset clears the failure state. Authentication failures use one generic response.

Manual or automatic locking closes the Stronghold client and zeroizes the in-memory data key. The default idle timeout is 15 minutes and can be disabled. Existing network connections remain active because a protocol backend may already have obtained a secret; new secret access requires unlocking. The renderer also locks the vault when the document becomes hidden, including application minimization and system screen locking. Normal shutdown explicitly locks the vault.

A forgotten master password cannot be recovered. Reset requires the dedicated backend confirmation and the exact `RESET` phrase; it deletes `vault.hold` and `vault.json` and clears saved-secret flags, but does not require the forgotten password. A corrupt snapshot fails closed and is not silently replaced with an empty vault.

### Windows Hello system unlock

On supported Windows 10/11 systems, system unlock is available only when Windows Hello and the Microsoft Platform Crypto Provider are available for the current user. Enabling it first asks Windows to verify the user, then creates a persisted 2048-bit RSA key in the platform provider and wraps the vault data key with RSA-OAEP/SHA-256. Unlock asks Windows Hello again before the platform key can unwrap that data key. FTPeach receives only the success/failure result; the PIN, face image, and fingerprint remain inside Windows.

The credential is tied to the current Windows user and platform provider. A policy change, removed credential, unavailable device, or Windows Hello cancellation makes system unlock fail closed. The master password remains the recovery path. Disabling system unlock deletes the persisted platform key and its wrapped-key metadata. macOS and Linux builds report the feature as unavailable; no fallback imitation or plaintext system credential is used.

System unlock uses the same process-wide serialization, rolling attempt limit, and generic authentication failure as password unlock. It improves convenience and resistance to copied vault files, but it does not protect against malware already controlling the logged-in Windows session or the FTPeach process.

### Restoring tabs at startup

`tabs.json` stores only non-secret pane data: a local path or a saved site's `siteId` and last remote path. Reconnection follows the same path as clicking a bookmark: the renderer sends only `siteId`, and the backend decrypts the password or passphrase through DPAPI or Stronghold. A locked vault opens the normal unlock dialog. Unsaved manual connections are never persisted and reopen as an empty Server form.

Legacy DPAPI fields migrate only while the vault is unlocked. Old ciphertext is removed only after writing and reading back the migrated secret, and `sites.json` is saved atomically. `sites.pre-stronghold.bak` must not contain plaintext. A remaining legacy field safely marks an incomplete migration for retry, while `vault-migration.json` records its version and state. Failed final saves restore `sites.json` from backup. Stronghold snapshots use a temporary sibling and atomic replacement.

## Threats and mitigations

| Threat | Current mitigation | Residual risk |
| --- | --- | --- |
| Malicious listing/path traversal | Single-segment filtering, safe path joins, percent encoding, canonical checks | Protocol parser bugs and new operations require separate review |
| Renderer XSS/compromise | Strict CSP, custom plugin permissions, one-use authorization tokens, secrets not returned to renderer | The renderer can still invoke non-sensitive operations granted to its window |
| FTP MITM | No cryptographic protection in plain FTP | Accepted risk; UI recommends FTPS/SFTP |
| FTPS/WebDAV MITM | TLS validation enabled by default | Users can explicitly enable `allowInvalidCert` |
| First-connection SFTP MITM | TOFU stores the first fingerprint | The first key should be verified through another channel |
| Changed SSH host key | Fail-closed mismatch and explicit pin reset | A user may approve a malicious replacement without verification |
| Poisoned update | HTTPS endpoint and signature verification | Release signing and publication still require operational discipline |
| Secrets at rest | DPAPI/Stronghold and fail-closed behavior | Same-session malware may act as the Windows user |
| Secrets in renderer | Backend-side decryption by `siteId` | Unsaved manual passwords necessarily pass through the renderer |
| Backend memory compromise | `zeroize` for connection configs and temporary buffers | Active protocol sessions need secrets; process-memory compromise is out of scope |
| Log leakage | Opt-in logs split into local-date files and retained for 14 days | Protocol/server text may still contain sensitive content |
| Dangerous local deletion | Protected paths, canonicalization, reparse rejection, guarded bottom-up deletion | Narrow TOCTOU window against another local process |
| Untrusted external-editor file | Isolated temporary copy and safe filename | External application behavior is outside FTPeach control |
| Oversized renderer/remote input | Typed validation and explicit byte/count/depth limits with `resourceLimit` errors | Limits bound individual operations, not total activity by a compromised renderer or server |
| Online vault guessing/Argon2 DoS | One process-wide KDF slot, exponential backoff, and rolling failure limit | Limits are process-local and reset when the application restarts |
| Windows Hello credential loss | Master-password recovery and fail-closed platform errors | Windows account/provider compromise is outside the application boundary |

## Local file launch policy

The backend distinguishes three operations: reveal a path in Explorer, open a non-executable document with its registered application, and execute executable/script content. A path must first come from a backend directory listing or native file dialog, is canonicalized immediately before use, and cannot be a Windows device path. UNC/network paths require native-dialog confirmation; merely appearing in a listing is insufficient.

Executable classification is extension-based and includes Windows programs, installers, shortcuts, scripts, control-panel/registry/help/disk-image formats, and other shell-active types such as `.exe`, `.com`, `.bat`, `.cmd`, `.ps1`, `.msi`, `.lnk`, `.url`, `.hta`, `.js`, `.vbs`, `.scr`, `.cpl`, `.reg`, `.chm`, and `.iso`. Such a path is rejected by the ordinary document command and must use the separate execute command. Remote **Open with** downloads to an isolated temporary path and applies the same classification.

When security confirmations are enabled, execution requires a backend-owned confirmation window showing the canonical target, followed by a short-lived token for that exact operation. Vault reset is always confirmed. Users may disable routine security confirmations in settings; command separation, path provenance, canonicalization, token binding, and executable classification still apply, but a compromised main renderer could then request an execution token without an interactive prompt.

## Input and resource limits

IPC strings are validated before storage or network use, including host, username, local/remote path, filename, proxy, and textual setting lengths. Imports are read with a 4 MiB ceiling, allow at most 2,000 sites, reject unknown and secret-bearing fields, and are applied only after the complete document validates. Renderer log input is limited to 2 MiB.

Remote directory responses are limited to 10,000 entries and 8 MiB of names/text. WebDAV PROPFIND XML is capped at 8 MiB before full parsing, WebDAV upload bodies stream through bounded buffers with at most 16 admitted bodies, remote paths at 4,096 bytes, filenames at 1,024 bytes, and recursive removal at 40 levels. Limit violations return stable `invalidInput` or `resourceLimit` errors instead of panicking or continuing to accumulate memory.

Protocol events are structured before they reach the renderer. Credential, authorization, token, private-key, and secret-named fields are replaced with `[REDACTED]`; the generic text redactor remains a final export/file-logging barrier. Redaction does not make diagnostics anonymous: server hostnames, IP addresses, user-selected local paths, and remote names may remain. Users should review diagnostic bundles before sharing them.

Vault password derivation and protected transitions share a single process-wide slot. Failed password or system unlock attempts wait with exponential backoff from 500 ms up to 30 seconds and stop after eight failures in a rolling five-minute window. A successful authentication or safe reset clears the state; expiration of the window clears it after the delay. The same generic error is returned for incorrect credentials and temporary throttling.

## Explicitly accepted risks

### Plain FTP

FTP without TLS remains for compatibility. Credentials, commands, and file contents are transmitted without encryption and may be read or modified in transit. Use FTPS or SFTP for sensitive data.

### `allowInvalidCert`

This option supports deliberately trusted local and legacy servers with self-signed or invalid certificates. It disables TLS peer authentication and makes MITM difficult to distinguish from the intended server. Enable it only when the network and server are consciously trusted.

### External applications

The user explicitly passes an untrusted file to another application. FTPeach does not sandbox the editor and cannot guarantee deletion of copies created by it.

### Full local file manager

The application is not restricted to folders selected through a native dialog. This is an intentional feature with broad access to user files. Backend invariants protect critical system and application-owned targets, but a user can still confirm deletion of an ordinary file by mistake.

### Authorized main renderer

The capability ACL prevents arbitrary windows and ungranted Tauri plugins from reaching sensitive commands, and operation tokens prevent reuse or target substitution. It does not make JavaScript in the authorized `main` window harmless. Operations without mandatory backend confirmation, including ordinary file management, can still be initiated after a renderer compromise. Strict CSP, dependency review, Rust-side validation, protected paths, and narrow command permissions are the compensating controls.

### Process-local throttling and limits

Vault throttling and resource ceilings prevent straightforward parallel KDF exhaustion and unbounded single-response allocation. They are not an account-wide lockout or global traffic quota: restarting the application resets attempt history, and repeated bounded operations can still consume CPU, disk, memory, or network capacity.

### Windows Hello and platform trust

System unlock trusts the current Windows account, Windows Hello, and the Microsoft Platform Crypto Provider. Loss or reset of that platform credential disables convenience unlock but does not replace the master-password recovery path. Malware acting as the signed-in user or code executing inside the FTPeach process remains outside this protection.

### RSA SSH client keys

RSA private-key authentication remains available for compatibility through a dependency affected by `RUSTSEC-2023-0071`. FTPeach recommends Ed25519 and warns when an RSA private key is selected. Key material is never logged or returned by ordinary IPC, but those controls do not remove the underlying timing vulnerability; use Ed25519 where the server supports it. The exception owner and review deadline are tracked in [`rust-advisories.md`](rust-advisories.md).

## Rules for future changes

See [file operation safety](transfer-safety.md) for protected Windows path identity,
replacement, directory move and remote staging policies, with regression test references.

- Grant specific `allow-*` permissions rather than `*:default`.
- Validate every new source of remote names as a path segment before UI or filesystem use.
- Implement canonical, protected-path, and reparse-point guards in Rust for every destructive local operation.
- Never log passwords, authorization headers, private keys, or their contents.
- Route new logging subsystems through shared redaction.
- Require a security review and regression test for updater endpoint, CSP, secret-storage, or host-key-policy changes.

## Vulnerability reporting

Use the repository's private vulnerability reporting as described in [`../SECURITY.md`](../SECURITY.md). Do not publish exploits, credentials, or technical vulnerability details in an ordinary issue.

## Verification limits

[Regression coverage](regression-coverage.md) maps the file-safety guarantees to executable tests. [Native validation](native-validation.md) separates browser, packaged process and live protocol coverage. Protected-path checks cover ordinary/extended drive paths, case, missing suffixes and available UNC aliases; they do not establish resistance to an external process replacing ancestors during a path-based commit. A passing mock test does not establish real server rename semantics or TPM behavior.
