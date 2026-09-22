# Settings and session storage

FTPeach currently supports the installed Windows storage model. It stores
`settings.json`, `sites.json`, `known_hosts.json`, and `tabs.json` under
`%APPDATA%\FTPeach`. Each file uses a `{ schemaVersion, data }` envelope,
atomic replacement, and a per-file write lock. Invalid JSON is preserved as a
timestamped `*.corrupt-*.bak` file before defaults are used.

Before replacing a valid file, the previous snapshot is saved as
`*.last-good.bak`. For `sites.json` and `settings.json` that snapshot keeps a saved secret
only where the new file holds the very same value: a password moved into the vault,
replaced or deleted is dropped from the backup, and legacy plaintext never reaches it.
Recovering from the backup therefore cannot bring back a weaker protection format. At
every start FTPeach applies the same rule to existing backups, deletes
`sites.pre-stronghold.bak` once no vault migration is in progress, and removes temporary
files an earlier run left behind. Timestamped `*.corrupt-*.bak` copies are kept byte for
byte for manual recovery. On a parse/schema error FTPeach keeps a timestamped copy of
the broken bytes, tries the last-good snapshot, and only then falls back to
defaults. It does not overwrite the corrupt original during that read.

For manual recovery, close FTPeach, copy the complete `%APPDATA%\FTPeach`
directory, and inspect the newest `*.corrupt-*.bak` and `*.last-good.bak`.
Restore a JSON file only from its matching last-good backup. Keep `vault.hold`
and `vault.json` together; a vault snapshot or forgotten master password cannot
be reconstructed from `sites.json`.

When Windows Hello system unlock is enabled, `vault.json` also contains the
wrapped vault data key and an identifier for a persisted key in the Microsoft
Platform Crypto Provider. It contains no Windows PIN or biometric material.
The persisted private key remains under the current Windows user's platform
provider; copying `vault.json` and `vault.hold` to another account or machine
does not copy that key. Keep the master password as the recovery method if the
Hello credential, TPM/provider, or Windows account changes.

`tabs.json` contains UI session data only: pane type, local or remote path,
saved site id, tab metadata, and synchronized-browsing state. It never stores
passwords, key passphrases, or ad-hoc connection configuration. Automatic
reconnection is disabled by default and can be enabled in connection settings.

`trusted_applications.json` lists the canonical paths of programs the user
picked in the **Browse** dialog or approved in a security confirmation for
**Open with** (at most 256, oldest dropped first). Deleting it only makes
FTPeach ask again the next time each program is used.

The “Save the session on exit” setting controls this snapshot. Turning it off
clears the saved tabs without affecting current connections or transfers and
prevents further session writes. “Reset Layout and Cache” independently resets
window and layout values.

## Updates

A downloaded update waits in `%LOCALAPPDATA%\com.smooveemaan.ftpeach\updates`:
the installer and a small `pending.json` with its version and signature. The
next launch verifies it and installs it silently before any window appears,
and the updated FTPeach removes the directory. An update never touches
`%APPDATA%\FTPeach`.

## Edits recovered from Open with

A file opened with **Open with** is downloaded to a per-run folder under
`%LOCALAPPDATA%\com.smooveemaan.ftpeach\edit-sessions`, outside Windows temporary-file cleanup.
Beside it, `copies.json` records each copy's server path and the modification time and size
of the version the server holds; it contains no passwords. On exit, and at the next start
after a crash, a copy that differs from that version is moved to
`%LOCALAPPDATA%\com.smooveemaan.ftpeach\recovered-edits`, one folder per file with an
`edit.json` naming its server path. Unchanged copies are deleted. FTPeach lists the recovered
files at start and deletes them only when the user chooses to. New Open with requests are
refused when editor sessions and recovery copies total 1 GiB, or contain a file last modified
30 days ago. Save or explicitly discard the retained work before opening more files. Limits
also apply after downloading a file of unknown size, before launching the editor. Concurrent
opens share admission. Existing editors can grow files beyond the limit; the limit never
deletes their work or interrupts an already-open editor.

If an editor prevents renaming or deleting its file, the original and its manifest stay in
the persistent session directory. Once the editor releases the file, the next start recovers
its latest contents. A snapshot is not substituted for a still-editable original. Legacy
sessions under `%TEMP%\ftpeach-openwith` are also recovered. An uninstall that keeps
application data keeps recovered edits too.

## Uninstall

The uninstaller’s confirmation page carries a “Delete the application data”
checkbox. It is unticked by default, so an ordinary uninstall leaves %APPDATA%\FTPeach
in place and a later reinstall picks the settings, sites, known hosts,
saved session and vault back up. Ticking it removes that directory in full,
including the vault and its `*.last-good.bak` snapshots, which cannot be
recovered afterwards — export settings first if the data is still wanted.

The choice is only offered on a real uninstall. An updater-driven uninstall
and a silent uninstall (`/P`) both keep the data, because neither shows the
page that asks. The stock Tauri checkbox only clears the bundle-id
directories, so `src-tauri/installer/hooks.nsh` removes the FTPeach data
directory itself; `npm run check:release-config` fails if that wiring is lost.

A real uninstall always removes the downloaded-update directory, ticked or not:
it belongs to the installation, not to the user.

One thing outlives the directory: when Windows Hello system unlock was
enabled, the persisted key in the Microsoft Platform Crypto Provider is not
reachable from the uninstaller and stays behind. It is inert without
`vault.json`, which the deletion removes.

## Portable mode

Portable storage beside the executable is not currently supported. A portable
build would need an explicit distribution marker and a writable application
directory; silently falling back from `%APPDATA%` is intentionally prohibited
because it would split state between locations and make secrets or settings
appear lost. If portable distribution enters the product plan, its storage
directory and migration policy must be selected before implementation.

## Resource and authentication limits

Settings import is capped at 4 MiB and 2,000 sites. The complete import is
schema- and range-validated before any settings or sites are committed, so a
rejected item cannot leave a partial update. Unknown fields and all legacy or
current secret representations are rejected. Stable `invalidInput` and
`resourceLimit` error codes distinguish malformed values from size/count
limits.

Vault password work is serialized to one KDF operation per process. Incorrect
password and failed Windows Hello attempts use exponential backoff from 500 ms
to 30 seconds and are limited to eight failures in a rolling five-minute
window. The counter is cleared after successful authentication or a completed
safe reset, and naturally expires after the window. This state is intentionally
in memory: restarting FTPeach resets it, so it is a local DoS/online-guessing
mitigation rather than a durable account lockout.
