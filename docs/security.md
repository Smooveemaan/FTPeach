# FTPeach threat model

This document describes the trust boundaries and defensive decisions of the current FTPeach desktop client. It is an engineering threat model, not a promise of absolute security or a release guide.

## Scope

The model covers the React/WebView renderer, Tauri IPC commands, the Rust backend, the local Windows filesystem, `%APPDATA%\FTPeach`, remote FTP/FTPS/SFTP/WebDAV servers, the updater endpoint, and applications that receive files through **Open with**.

The security of Windows and the user's account, vulnerabilities in WebView2 or an external editor after it receives a file, and compromise of the FTPeach process with full memory access are outside the model.

## Protected data

- saved site passwords, SSH-key passphrases, and the proxy password;
- private SSH keys and their paths;
- local and remote file contents;
- saved sites, settings, and SFTP host-key fingerprints;
- updater artifacts and application code;
- diagnostic and protocol logs.

## Trust boundaries

### Renderer and Tauri/Rust

The renderer is less trusted, but it is not a sandboxed security principal. `build.rs` declares an application manifest for every registered command, which is what makes the ACL apply to them at all; `default.json` then grants the main window the event/window `allow-*` permissions and the app commands it needs; updater, dialog, notification, and opener capabilities are exposed through narrow Rust commands rather than directly to JavaScript. Ordinary browsing, connection, transfer, and settings commands remain available to the main renderer and validate their inputs in Rust.

Sensitive file, reset, secret-reveal, and import/export operations are registered in the `sensitive` Tauri plugin and are available only to the `main` window through explicit permissions. Every call requires a one-use token bound to the requesting window, exact operation, canonical path or logical target, and the vault session it was issued in. A token lives 30 seconds, except a `settings_set_security` token, which lives 15 minutes because the settings dialog confirms a relaxed protection the moment the user makes the change and saves it only when the dialog is saved. The backend itself opens a separate confirmation window for secret reveal, vault reset, and executable content when required. Delete, reveal-in-Explorer, ordinary document open, and import/export do not always show a backend confirmation; a compromise of the authorized main renderer can request their tokens. Canonical paths, protected targets, native-dialog provenance, and reparse-point checks remain enforced in Rust.

The production CSP is defined only in `tauri.conf.json`. Scripts are restricted to `self`, without `unsafe-eval` or external script sources. `npm run check:release-config` rejects broad `*:default` permissions, a duplicate HTML CSP, or a weakened script policy.

`sites_list` does not return saved passwords. The renderer sees only `hasPassword` and `hasKeyPassphrase` and supplies a `siteId` when connecting. The backend loads the associated configuration, preventing the renderer from redirecting one site's password to an arbitrary host.

Normal listing and editing IPC returns only presence flags. An explicit reveal uses a short-lived one-use token; Stronghold additionally requires master-password reauthentication before that token is issued. The renderer clears a revealed value on blur, hide, vault lock, dialog close, and unmount.

### Rust and the local filesystem

FTPeach is intentionally a full local file manager, so it does not impose a selected-folder allowlist. Destructive commands canonicalize paths in the backend and reject drive roots, the user profile, the application directory, `%APPDATA%\FTPeach`, and their parents.

Recursive deletion does not use `remove_dir_all`. It walks bottom-up and rejects symlinks, junctions, and all Windows reparse points. Checks are repeated before every deletion and retry. A narrow TOCTOU risk remains against a local process that can replace filesystem entries concurrently.

### Rust and remote servers

Remote listing names are untrusted. Empty names, `.` and `..`, and names containing path separators are rejected before reaching UI or path operations. WebDAV URLs use percent-encoded segments. Recursive FTP and SFTP operations have depth limits.

FTPS and WebDAV verify TLS certificates by default. SFTP pins the server's key in `known_hosts.json`. With `strictHostKeyCheck`, which is on by default, a first sighting is refused rather than pinned: the connection stops before any credential is offered, the backend's own confirmation window shows the fingerprint, and only `session_trust_host_key` writes it. Turning that setting off restores trust on first use and is a weakening, so it goes through `settings_set_security` like the others. A changed key blocks the connection either way.

Before any of that, a path is checked for the network namespace from its text alone. Resolving a UNC path is itself network access: `canonicalize` and `metadata` make Windows contact the server, and on a default configuration that hands it an authentication attempt, so a check that runs after resolution runs too late. `ApprovedLocalPaths::preflight` compares the requested spelling against the shares a native dialog confirmed, normalizing `\\?\UNC\server\share` and `\\server\share` to the same key, and refuses an unconfirmed one before any syscall. It runs first in `fs_list`, `fs_is_dir`, `fs_mkdir`, `fs_rename`, `fs_copy_file`, `fs_create_file`, `fs_validate_copy`, the reveal/open/execute trio and `fs_delete` — ahead of the authorization token, whose target normalization used to canonicalize the path before the token was even looked up — and in `session_connect` for a private key or CA bundle the protocol backend would otherwise open itself. The canonical check stays behind it for a path that only becomes a share once resolved, such as a local symlink pointing at one. A wedged share leaves its call blocked inside Windows and a timeout does not take that OS worker back, so what is bounded is how many such probes may be in flight: four, in `fs_list` and in `fs_is_dir`.

`session_trust_host_key` replaced an unconditional "forget the pinned key". That command let a renderer delete a pin and reconnect, after which whatever key it was offered became the new first sighting. The new one is in the `sensitive` plugin, so it needs a grant the backend issues only after its confirmation window has shown both fingerprints; the grant is bound to the host, the port, the expected fingerprint and the actual one, so it cannot be spent on another server or another pair of keys. The write is a compare-and-swap under the trust store's lock: if the stored key moved on while the user was deciding, the confirmation was about a different pair of keys, and the write is refused rather than applied. A damaged trust store still fails closed and is never silently replaced.

A WebDAV password is only ever put on the wire from an address that has earned it. An `http://` address is probed unauthenticated: if the server redirects to `https://` on the same host and path, the address is upgraded and only the retry carries credentials; a redirect anywhere else is refused, and the upgrade never runs the other way. If the server asks for a password while the connection is still in the clear, the connection fails and says so rather than authenticating or falling back to an anonymous session. Signing in over plain HTTP needs the per-connection `allowCleartextAuth` opt-in, which is offered only for an `http://` address. A server that wants no password is still browsable over plain HTTP. A WebDAV address may not contain URL userinfo, a query string or a fragment, so a bookmark, a log line or a settings export has no second place to carry a secret.

A connection configured without a proxy states that: the HTTP client is built with `no_proxy()`, so `HTTP_PROXY` and `HTTPS_PROXY` in the environment cannot reroute a connection the settings describe as direct. `tests/webdav_proxy_policy.rs` asserts this in its own process.

### Updater endpoint and application

The production endpoint must use HTTPS, cannot target loopback, and is checked automatically. Tauri also verifies artifact signatures with the configured public key. The private signing key must never be included in the repository or user builds.

A downloaded update waits in `%LOCALAPPDATA%\com.smooveemaan.ftpeach\updates` until the next launch or an explicit **Install update**. The installer is verified against the same public key again immediately before it runs, so a file changed or truncated on disk is discarded rather than executed. For that check the installer is opened so that nothing can write, replace, rename or delete it, and the staging folder and its parent are held so they cannot be renamed; reparse points are refused, the bytes are read through that handle, and the process is started before the handles close, so what runs is what was verified, even after a long shutdown. The unsigned `pending.json` may name only `FTPeach-<version>-setup.exe` for its own version, and both files are size-limited before they are read. Anti-rollback relies on the signed bytes: the product version Tauri's NSIS installer embeds (`VS_FIXEDFILEINFO`) must equal the announced version and be newer than the running build, and an installer without it is refused. File-manager commands cannot read or write the staging folder. The download itself has a 30-minute deadline; its size is checked once the updater plugin has received it, since the plugin keeps the whole download in memory. An install that does not complete is not retried from the same download, so a broken installer cannot turn every launch into another failed install.

### FTPeach and external applications

**Open with** downloads an untrusted remote file to a temporary directory and passes it to the Windows-registered application. FTPeach removes its unchanged temporary copies on a best-effort basis but cannot control editor vulnerabilities, recent-file history, backups, or cloud synchronization. A file modified by the external application may be offered for upload to the server; a modified copy that was never uploaded is moved to the recovery folder described in [storage](storage.md) instead of being deleted.

## Secret storage modes

Saved secrets are a site's password, an SSH-key passphrase, and the global proxy password. The user chooses one of two modes, and every saved secret follows it:

- **System protection** (the default) encrypts each secret with DPAPI for the signed-in Windows account and keeps the ciphertext in `sites.json` or `settings.json`. No master password is involved, so anyone acting as that Windows user can read the secrets.
- **Enhanced protection** keeps them in the vault, a Stronghold snapshot encrypted under a master password. They cannot be read until the vault is unlocked.

In both modes the renderer never receives a secret on ordinary IPC: it supplies a `siteId`, and the Rust backend resolves the password and the proxy password itself.

Switching modes moves every saved secret. Turning on enhanced protection moves DPAPI and plaintext values into the vault. A value still left in DPAPI, for example after an interrupted migration, moves at the next unlock; saving a new secret while the vault is locked is refused rather than written to DPAPI. Turning it off copies every vault secret back to DPAPI before the vault is removed, so a failure leaves the vault intact: sites and settings are put back as they were, with no DPAPI copy left behind. It goes through the sensitive `vault_use_system_protection` command, whose backend confirmation window always asks for the master password, even when the vault is already unlocked; the renderer cannot supply or skip it. The switch is serialized with other vault updates, and removing the vault locks it, which withdraws every token issued before. Connections that are already open keep the credentials they authenticated with.

## Stronghold and the master password

Under enhanced protection, saved site passwords, private SSH-key passphrases, and the proxy password are stored in `%APPDATA%\FTPeach\vault.hold`. After migration, `sites.json` contains only non-secret parameters and `hasPassword`/`hasKeyPassphrase` flags, and `settings.json` holds only a `hasProxyPassword` flag. Saving or removing a secret, connecting with one, and revealing one all require an unlocked vault; a locked vault opens the unlock dialog, including for an unsaved connection that goes through a password-protected proxy.

Setup creates a random 32-byte data key. Stronghold encrypts the snapshot with this key, while Argon2id derives the key that wraps it from the master password. `vault.json` stores the format version, unique salt, and KDF parameters, but never the master password or data key. Current production parameters are Argon2id v1, 64 MiB of memory, three passes, and one lane. Changing the master password rewraps the data key without re-encrypting every secret.

All KDF and protected vault transitions share one process-wide semaphore. Failed authentication uses exponential backoff from 500 ms to 30 seconds and is limited to eight failures in a rolling five-minute window. Successful authentication or a completed safe reset clears the failure state, and failures older than the window stop counting. Incorrect credentials and temporary throttling return the same generic response.

Every credential FTPeach holds in memory — a site password, an SSH key passphrase, the proxy password, the master password as it arrives over IPC — is a `security::sensitive_string::SensitiveString`. It clears its buffer when it goes out of scope, so each copy forgets itself rather than relying on one hand-written `zeroize()` that a cancelled future may never reach, and it prints `[REDACTED]` through both `Debug` and `Display`, so a `{config:?}` in a log line cannot spill one. A connection's credentials are released when the session is disconnected rather than kept in the backend until something else drops it. A test builds a real FTP, SFTP and WebDAV config with a marker password and fails if that marker appears in the `Debug` output of the config or of its proxy.

This does not mean the bytes are gone from the process. A `String` that grew leaves its old buffer behind, `serde_json` held the password while parsing the IPC request, and the TLS, HTTP and SSH libraries, the WebView and Windows itself keep copies of their own on the way to the wire. What is bounded is how long FTPeach's own copies live and where they can be printed.

Manual or automatic locking closes the Stronghold client, zeroizes the in-memory data key and withdraws every unused authorization grant. The auto-lock is enforced in the backend (`security::auto_lock` decides, `runtime::vault_auto_lock` acts) on a five-second timer, so it does not depend on the renderer's event loop: a WebView that has hung, reloaded or never finished loading cannot keep the vault open. Two rules apply. The idle timeout defaults to 15 minutes and can be disabled; the renderer only reports that it has seen the user, which can postpone that timeout but never remove it. Separately, and whatever the timeout is set to, the vault locks when the Windows desktop session is locked, queried through `WTSQuerySessionInformationW`, or when the main window is hidden to the tray or minimized; a session state the platform cannot report counts as not locked and leaves the idle timeout in charge. Existing network connections remain active because a protocol backend may already have obtained a secret, and a session that is already open may still open further transfer connections with the credentials it authenticated with; what a lock does take away is access to a secret it does not already hold, so saving or revealing one asks for an unlock. Normal shutdown explicitly locks the vault.

A forgotten master password cannot be recovered. Reset requires the dedicated backend confirmation and the exact `RESET` phrase; it deletes `vault.hold` and `vault.json` and clears saved-secret flags, including the proxy password's, but does not require the forgotten password. A corrupt snapshot fails closed and is not silently replaced with an empty vault.

### Windows Hello system unlock

On supported Windows 10/11 systems, system unlock is available only when Windows Hello and the Microsoft Platform Crypto Provider are available for the current user. Enabling it first asks Windows to verify the user, then creates a persisted 2048-bit RSA key in the platform provider and wraps the vault data key with RSA-OAEP/SHA-256. Unlock asks Windows Hello again before the platform key can unwrap that data key. FTPeach receives only the success/failure result; the PIN, face image, and fingerprint remain inside Windows.

The credential is tied to the current Windows user and platform provider. A policy change, removed credential, unavailable device, or Windows Hello cancellation makes system unlock fail closed. The master password remains the recovery path. Disabling system unlock deletes the persisted platform key and its wrapped-key metadata.

System unlock uses the same process-wide serialization, rolling attempt limit, and generic authentication failure as password unlock. It improves convenience and resistance to copied vault files, but it does not protect against malware already controlling the logged-in Windows session or the FTPeach process.

### Restoring tabs at startup

A saved password belongs to its recipient: the protocol, host, port, account, WebDAV URL and TLS policy (encryption, certificate checks, custom CA) of the bookmark, or the type, host, port and account of the proxy. Saving a bookmark goes through the sensitive `sites_save` command, and the proxy's address travels with its password through `settings_set_security`. When an edit changes the recipient and keeps the saved password, the backend shows a confirmation with the old and the new recipient, and warns when the new one drops encryption or certificate checks; the confirmation is shown even with routine confirmations turned off. The token is bound to that exact move and is checked against the bookmark as stored when the save runs. Renaming, recoloring, moving a bookmark between folders or changing its connection limit needs no confirmation, and neither does entering a new password or removing the saved one. `settings_set` refuses a proxy change that would move the saved proxy password, and a settings import keeps the current proxy address instead. Key passphrases unlock a local key file and are never sent to a server, so they are not tied to a recipient.

`tabs.json` stores only non-secret pane data: a local path or a saved site's `siteId` and last remote path. Reconnection follows the same path as clicking a bookmark: the renderer sends only `siteId`, and the backend decrypts the password or passphrase through DPAPI or Stronghold. A locked vault opens the normal unlock dialog. Unsaved manual connections are never persisted and reopen as an empty Server form.

A secret that cannot be encrypted is never written in the clear and never silently dropped: the save fails, the previously saved value stays, and the caller is told. A revealed secret belongs to the bookmark, field and input it was asked for; an answer that arrives after the editor moved to another bookmark, after the user typed a password, or after the vault locked or the window lost focus is discarded, and the field stays hidden.

Under enhanced protection, DPAPI fields migrate into the vault only while it is unlocked. Old ciphertext is removed only after writing and reading back the migrated secret, and `sites.json` is saved atomically. `sites.pre-stronghold.bak` must not contain plaintext, and it is deleted as soon as the migration completes. Last-good backups keep a secret only while the live file holds the same value, so neither DPAPI copies of vault secrets nor plaintext survive in them; existing backups are brought in line at start. Cleaning up FTPeach's own files does not erase copies on SSD blocks, Volume Shadow Copies, cloud sync or external backups; if a password may have been exposed that way, change it on the server. A remaining legacy field safely marks an incomplete migration for retry, while `vault-migration.json` records its version and state. Failed final saves restore `sites.json` from backup. Stronghold snapshots use a temporary sibling and atomic replacement.

## Threats and mitigations

| Threat | Current mitigation | Residual risk |
| --- | --- | --- |
| Malicious listing/path traversal | Single-segment filtering, safe path joins, percent encoding, canonical checks | Protocol parser bugs and new operations require separate review |
| Renderer XSS/compromise | Strict CSP, custom plugin permissions, one-use authorization tokens, secrets not returned to renderer | The renderer can still invoke non-sensitive operations granted to its window |
| FTP MITM | No cryptographic protection in plain FTP | Accepted risk; UI recommends FTPS/SFTP |
| FTPS/WebDAV MITM | TLS validation enabled by default | Users can explicitly enable `allowInvalidCert` |
| SMB authentication to an unchosen share | UNC paths are refused from their text before any filesystem call | A share the user picked in a dialog is reachable as they intended; what Windows does with the credentials of an allowed share is its own policy |
| SSH man-in-the-middle on first contact | `strictHostKeyCheck` refuses an unpinned key and shows its fingerprint before credentials are offered | The user still has to compare the fingerprint with one obtained out of band; turning the setting off restores trust on first use |
| WebDAV password on a cleartext connection | `http://` is probed unauthenticated and upgraded to `https://` before credentials are sent | Users can explicitly enable `allowCleartextAuth`; a server reached over plain HTTP still sees the request itself |
| First-connection SFTP MITM | TOFU stores the first fingerprint | The first key should be verified through another channel |
| Changed SSH host key | Fail-closed mismatch and explicit pin reset | A user may approve a malicious replacement without verification |
| Poisoned update | HTTPS endpoint and signature verification | Release signing and publication still require operational discipline |
| Secrets at rest under system protection | DPAPI bound to the Windows account | Anyone acting as that Windows user can read them without a master password |
| Secrets at rest under enhanced protection | Stronghold vault behind the master password, fail-closed behavior | Same-session malware may act as the Windows user while the vault is unlocked |
| Secrets in memory and in logs | Every credential is a self-clearing `SensitiveString` that formats as `[REDACTED]`; connections release theirs on disconnect | Library, WebView and OS copies are outside FTPeach's reach, and a process dump while the vault is unlocked still exposes what is in use |
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

An **Open with** token covers the whole request: the connection, the remote path, the local file name the download is saved under, its classification, and the canonical program that opens it. The classification comes from that final local name, not the remote one, so `report.cmd.` (saved as `report.cmd`) is confirmed as a script; the confirmation shows the local name when it differs. A request that differs in any field after the token was issued is refused, and the saved file and program are checked again immediately before launch. Appearing in a directory listing does not make a program acceptable: a program joins the backend's trusted list (`trusted_applications.json`, which no renderer command writes) only when picked in the native **Browse** dialog or approved in a confirmation window; until then, opening even a document with it asks first.

When security confirmations are enabled, execution requires a backend-owned confirmation window showing the canonical target, followed by a short-lived token for that exact operation. Vault reset is always confirmed. Users may disable routine security confirmations in settings; command separation, path provenance, canonicalization, token binding, and executable classification still apply, but a compromised main renderer could then request an execution token without an interactive prompt.

The renderer cannot make that decision for the user. `settings_set` refuses to turn security confirmations off or to lengthen or disable the vault idle lock; only the sensitive `settings_set_security` command does, after a backend confirmation window that is shown whatever the confirmation setting says and that asks for the master password when a vault is configured. Strengthening either setting needs no confirmation. A settings import keeps the current protection instead of relaxing it. Once the policy changes, every unused token is withdrawn, and a token issued before the vault was last locked is refused.

The settings dialog asks for that confirmation the moment the switch moves, not when the dialog is saved, and holds the token until then: nothing is written before Save, and declining simply leaves the switch where it was. The confirmation window is written in the language the main window is showing, which the dialog may itself be previewing, so the renderer passes that language with the request; only the shape of a language tag is trusted from there, and the window falls back to English for one it has no translations for.

## Input and resource limits

IPC strings are validated before storage or network use, including host, username, local/remote path, filename, proxy, and textual setting lengths. Imports are read with a 4 MiB ceiling, allow at most 2,000 sites, reject unknown and secret-bearing fields, and are applied only after the complete document validates. Renderer log input is limited to 2 MiB.

FTP control replies are bounded as well, from the greeting on: 8 KiB per line, 256 KiB and 4,096 lines per reply, in the patched `suppaftp` copy under `src-tauri/vendor/suppaftp` and in FTPeach's own encoding relay. A server that exceeds them loses the connection and the operation returns `resourceLimit`, without the reply text reaching errors or logs. In active mode the data connection is accepted only from the server's address, so another local program cannot answer the listener first; this is not protection against an attacker who also controls the network path.

Remote directory responses are limited to 10,000 entries and 8 MiB of names/text. WebDAV PROPFIND XML is capped at 8 MiB before full parsing, WebDAV upload bodies stream through bounded buffers with at most 16 admitted bodies, remote paths at 4,096 bytes, filenames at 1,024 bytes, and recursive removal at 40 levels. Limit violations return stable `invalidInput` or `resourceLimit` errors instead of panicking or continuing to accumulate memory.

Protocol events are structured before they reach the renderer. Credential, authorization, token, private-key, and secret-named fields are replaced with `[REDACTED]`; the generic text redactor remains a final export/file-logging barrier. Redaction does not make diagnostics anonymous: server hostnames, IP addresses, user-selected local paths, and remote names may remain. Users should review diagnostic bundles before sharing them.

Vault unlock attempts are throttled as described in [Stronghold and the master password](#stronghold-and-the-master-password).

## Explicitly accepted risks

### Plain FTP

FTP without TLS remains for compatibility. Credentials, commands, and file contents are transmitted without encryption and may be read or modified in transit. Use FTPS or SFTP for sensitive data.

### `allowInvalidCert`

This option supports deliberately trusted local and legacy servers with self-signed or invalid certificates. It disables TLS peer authentication and makes MITM difficult to distinguish from the intended server. Enable it only when the network and server are consciously trusted.

### System protection

System protection is the default because it needs no master password and cannot lock the user out. DPAPI ties the secrets to the Windows account, which protects copied files but not the account itself: any process or person acting as that user can decrypt them. Users who need more choose enhanced protection.

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
