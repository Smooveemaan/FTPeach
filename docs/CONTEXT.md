# FTPeach

A Windows desktop file manager for local files and remote FTP, FTPS, SFTP, and WebDAV servers. This glossary fixes the words used in the product, its security documents, and its code.

## Security

**Supported release**:
The latest published FTPeach release. Security fixes ship only as a new release delivered through the updater; older releases and unreleased commits are not supported.
_Avoid_: supported version, main branch

**System protection**:
The secret-storage mode in which saved secrets are encrypted for the signed-in Windows account, with no master password. Anyone acting as that Windows user can read them.
_Avoid_: Windows account protection, DPAPI mode, legacy storage

**Enhanced protection**:
The secret-storage mode in which every saved secret, including the proxy password, lives in the vault and is unreadable until the vault is unlocked.
_Avoid_: Stronghold mode, protected mode

**Vault**:
The master-password-encrypted store that holds saved secrets under enhanced protection. It is either locked or unlocked.
_Avoid_: protected storage, Stronghold (the library versions up to 0.5 kept it in; see ADR 0008)

**Saved secret**:
A password or passphrase FTPeach keeps between launches: a saved site's password, an SSH-key passphrase, or the proxy password. Passwords typed for an unsaved connection are not saved secrets.
_Avoid_: credential, stored password

**System unlock**:
Unlocking the vault with Windows Hello instead of the master password. It belongs to enhanced protection and is unrelated to system protection despite the similar name.
_Avoid_: Windows Hello unlock, biometric unlock

**Accepted risk**:
A known weakness the project keeps on purpose and documents in the threat model. A report that only demonstrates an accepted risk is not a vulnerability.
_Avoid_: known issue, won't fix

## Editing server files

**Edit copy**:
The local copy of a server file that Open with hands to another program. FTPeach watches it while the file's connection stays open and offers each save for upload back to the same file. A server file (the same server, account and path, whichever tab opens it) has at most one watched edit copy: opening it again, in any program, reuses that copy. Once its connection closes, the next Open with makes a new edit copy.
_Avoid_: open-with copy, temp file, local copy

## Interface and code

The interface's English words are the ones in `src/i18n/locales/en.json`; translations use each language's word for the same thing, kept consistent across its strings. Code may use its own name for a thing only where this glossary gives one.

**Pane**:
One of the two file lists in a tab, local or remote. Its settings, history and search belong to it.
_Avoid_: panel, window, side

**Tab**:
A pair of panes with their connections, opened and closed as one.
_Avoid_: page, workspace

**Bookmark**:
A saved server: its address, protocol, account and settings, optionally with saved secrets, kept in the Bookmarks list and its folders. In code and in files on disk the record is a _site_ (`ManagedSite`, `sites.json`); names that describe what the user sees or does, such as a test's name or the export's `includeBookmarks`, say bookmark.
_Avoid_: site (in anything a user reads), saved connection, profile, favourite

**Local path**:
A saved folder on this computer, kept beside the bookmarks and opened in a local pane.
_Avoid_: local bookmark, shortcut

**Folder**:
A directory, local or on a server. Protocol commands and replies keep their own word, such as "directory listing" in a server's reply, and code keeps the platform's (`is_dir`, `mkdir`).
_Avoid_: directory, collection (except when naming WebDAV's)

**Connection**:
A pane's live link to a server, from connecting to disconnecting. In code a connection is held by a _session_; to the user, the session is what is restored at the next launch (open tabs, pane types and paths).
_Avoid_: session (for a connection, in anything a user reads), link, login

**Transfer**:
One upload, download or copy between servers, as one row of the Transfers list. A folder transfer is one row for the whole folder.
_Avoid_: job, task (except the pool's task in code)

**Pause / Resume / Stop / Retry**:
Pause keeps what a transfer wrote so Resume carries on from it; Stop ends it and takes back what it wrote; Retry runs a failed or stopped transfer again.
_Avoid_: cancel (for Stop), continue (for Resume), restart

**Log**:
The protocol log panel: the commands and replies of each connection, and FTPeach's own lines about them.
_Avoid_: console, history
