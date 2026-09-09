# Settings and session storage

FTPeach currently supports the installed Windows storage model. It stores
`settings.json`, `sites.json`, `known_hosts.json`, and `tabs.json` under
`%APPDATA%\FTPeach`. Each file uses a `{ schemaVersion, data }` envelope,
atomic replacement, and a per-file write lock. Invalid JSON is preserved as a
timestamped `*.corrupt-*.bak` file before defaults are used.

Before replacing a valid file, the previous snapshot is saved as
`*.last-good.bak`. On a parse/schema error FTPeach keeps a timestamped copy of
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

The “Save the session on exit” setting controls this snapshot. Turning it off
clears the saved tabs without affecting current connections or transfers and
prevents further session writes. “Reset Layout and Cache” independently resets
window and layout values.

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
