# Settings and session storage

## Files and backups

FTPeach currently supports the installed Windows storage model. It stores
`settings.json`, `sites.json`, `local-paths.json`, `known_hosts.json`, and `tabs.json` under
`%APPDATA%\FTPeach`. Each file uses a `{ schemaVersion, data }` envelope,
atomic replacement, and a per-file write lock; a bare legacy array or object is read as
schema 0, and a newer schema keeps the file read-only. Unreadable contents are preserved
as `*.corrupt-<hash>.bak` before defaults are used. The name follows the content, so the
same damage is kept once, and only the five newest copies per file are kept.

Before replacing a file, the previous snapshot is saved as `*.last-good.bak`, but only
if it still decodes as that file's data: syntactically valid JSON of the wrong shape
never displaces a recoverable backup. The backup is flushed and renamed into place; if
that fails, the save still happens and the failure is shown as a storage warning. For `sites.json` and `settings.json` that snapshot keeps a saved secret
only where the new file holds the very same value: a password moved into the vault,
replaced or deleted is dropped from the backup, and legacy plaintext never reaches it.
Recovering from the backup therefore cannot bring back a weaker protection format. At
every start FTPeach applies the same rule to existing backups, deletes
`sites.pre-stronghold.bak` once no vault migration is in progress, and removes temporary
files an earlier run left behind. `*.corrupt-*.bak` copies are kept byte for
byte for manual recovery. On a parse/schema error FTPeach keeps a copy of
the broken bytes, tries the last-good snapshot, and only then falls back to
defaults. It does not overwrite the corrupt original during that read.

For manual recovery, close FTPeach, copy the complete `%APPDATA%\FTPeach`
directory, and inspect the newest `*.corrupt-*.bak` and `*.last-good.bak`.
Restore a JSON file only from its matching last-good backup. Keep `vault.hold`
and `vault.json` together; a vault snapshot or forgotten master password cannot
be reconstructed from `sites.json`.

When Windows Hello system unlock is enabled, `vault.json` also contains, for
each computer it was enabled on, the wrapped vault data key and an identifier
for a persisted key in the Microsoft Platform Crypto Provider. It contains no
Windows PIN or biometric material. The persisted private key remains under
that Windows user's platform provider; copying `vault.json` and `vault.hold`
to another account or machine does not copy that key. System unlock therefore
counts as enabled only where the key can be opened: elsewhere the master
password unlocks the vault and Windows Hello can be enabled again for that
computer, without disturbing the others. Disabling it removes that computer's
entry and key. The list holds eight computers; a ninth replaces the oldest.
A single entry written by an earlier version is still read. Keep the master
password as the recovery method if the Hello credential, TPM/provider, or
Windows account changes.

`tabs.json` contains UI session data only: pane type, local or remote path,
saved site id, tab metadata, and synchronized-browsing state. It never stores
passwords, key passphrases, or ad-hoc connection configuration. It holds at most 256
tabs, ids up to 128 bytes, names up to 1 KiB and paths up to a Windows long path; a
larger session is refused with `resourceLimit` rather than saved in part, and a file
over the limits is cut to them on read. A repeated tab id keeps its first tab, and an
active id naming no kept tab is dropped. Automatic
reconnection is disabled by default and can be enabled in connection settings.

`trusted_applications.json` lists the canonical paths of programs the user
picked in the **Browse** dialog or approved in a security confirmation for
**Open with** (at most 256, oldest dropped first). Deleting it only makes
FTPeach ask again the next time each program is used.

The “Save the session on exit” setting controls this snapshot. Turning it off
clears the saved tabs without affecting current connections or transfers and
prevents further session writes. “Reset Layout and Cache” independently resets
window and layout values.

Session writes replace the whole snapshot, so they run one at a time in the
order their snapshots were taken, and a snapshot a newer one has replaced is
dropped instead of stored after it. A write the backend refuses — a full disk, a
read-only profile — is reported to the user once rather than mistaken for a
stored session; the next change retries it. The same applies to clearing the
snapshot when session saving is turned off.

## State at exit

Before native shutdown, the main renderer receives `app:flush-state` with a fresh
request ID. Settings cancel their 75 ms debounce and drain serialized revisions;
tabs cancel their 400 ms debounce, enqueue the current snapshot (or clear if session
saving is disabled), and await the writer. Failed settings retain their pending patch
for retry; failed tab writes report failure. All state owners start their drains even
if another owner is slow or fails. Only `main` can acknowledge the current request
through `app_state_flushed`. The backend logs a failed acknowledgement or a three-second
timeout and continues cleanup. Window close reads close-to-tray after the same
handshake, but waits only 400 ms for it: hiding to the tray loses nothing if the
debounce fires by itself a moment later, and the window has to disappear when the
button is clicked. Hiding preserves the session. Quit and immediate update installation use the same
handshake. Abrupt termination and an unresponsive renderer cannot guarantee the last
unsent change (HF-12).

## Protocol log budgets

The writer admits at most 512 records without waiting on the disk. Text and event
parameters are capped at 8 KiB, connection/server labels at 512 bytes each, and
batches at 128 records (therefore below 1.3 MiB of payload). The recent ring retains
at most 5,000 records and 4 MiB of accounted payload. Overflow drops disk/live
records, keeps bounded recent history and queues one aggregate drop notice when
the writer recovers; it never logs that notice recursively. The notice is a
translated event (`log.droppedRecords`), so the panel shows it in the interface
language while the log file and diagnostic bundle keep the English sentence. Renderer history and
live batches waiting for a history response also have 5,000-entry/4 MiB limits.
Quit and immediate update installation drain admitted log records with a two-second
deadline. Daily rotation, age and directory-size policies still apply (HF-15).

## Updates

A downloaded update waits in `%LOCALAPPDATA%\com.smooveemaan.ftpeach\updates`:
the installer and a small `pending.json` with its version and signature. FTPeach's own
file operations cannot read or write this folder. The
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
`edit.json` naming its server path and a `file` folder holding the copy, so a file named
`edit.json` cannot replace its own description. Folders from earlier versions, with the copy beside
`edit.json`, are still listed; so is a folder whose description is missing or unreadable, under
the name of the file it holds. If no described payload exists, a lone edit.json stays visible even when its contents parse as a description: it may be an edited file left by the old name collision. Unchanged copies are deleted. FTPeach lists the recovered
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

A copy of FTPeach is portable when a file named `FTPeach.portable` sits beside
its program; the release's `FTPeach_<version>_x64-portable.zip` carries it.
That file is the whole switch. A `data` folder without it changes nothing, and
FTPeach never falls back from one location to the other, because state split
between the two would make secrets or settings appear lost.

A portable copy keeps everything beside the program:

| An installed copy uses | A portable copy uses |
| --- | --- |
| `%APPDATA%\FTPeach`: settings, sites, known hosts, tabs, vault, logs | `data\` |
| `edit-sessions`, `recovered-edits` and `updates` under `%LOCALAPPDATA%\com.smooveemaan.ftpeach` | the same folders under `data\local\` |
| the WebView2 profile under `%LOCALAPPDATA%\com.smooveemaan.ftpeach` | `data\webview\` |

The rest of this page applies with those folders in place of the profile ones.
When `data\` cannot be created or written, as on a read-only disk, FTPeach says
so in a message box and exits. FTPeach's own file operations cannot read or
change the program's folder; the editor copies under `data\local\edit-sessions`
and `data\local\recovered-edits` are the exception, as they are the user's own
files.

What stays on a computer, or does not follow the folder:

- Passwords saved under system protection are encrypted by Windows for the
  account that saved them. On another computer or account the bookmarks are
  there and those passwords cannot be read; back on the first one they read
  again. With a master password the vault is in `data\` and travels as it is.
- Windows Hello unlock uses a key in the computer's platform provider (see
  above). On another computer the master password unlocks the vault until
  Windows Hello is enabled there too. The key stays in that computer's
  provider until Windows Hello unlock is disabled there, so disable it before
  leaving a computer for good.
- Windows needs a registry entry to put FTPeach's name and icon on its
  notifications: `HKCU\Software\Classes\AppUserModelId\com.smooveemaan.ftpeach`.
  A portable copy writes it at start and removes it on exit, unless an
  installed FTPeach on the same computer uses it too. A crash leaves it until a
  later run exits.
- Saved local paths and **Open with** programs are absolute, so they name one
  computer's drives. So is a key or certificate file kept outside the
  program's folder. One chosen from inside the folder is saved relative to it
  (`keys\id_ed25519`) and found again when the folder moves or its drive gets
  another letter; an installed copy does not read such a path.
- A portable and an installed copy share the single-instance lock: starting
  one while the other runs brings up the running one.
- The WebView2 runtime is not in the zip. Windows 11 always has it.

A portable copy updates itself from the same zip. It waits in
`data\local\updates` as an installer does in [Updates](#updates). Installing
it unpacks it there, moves the files into the program's folder with the
program last and starts the new program; the old one, kept as
`FTPeach.exe.old`, is removed at the start after that. An update never writes
to the rest of `data\`.

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
