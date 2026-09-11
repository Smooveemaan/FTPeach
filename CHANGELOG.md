# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow SemVer.

## [Unreleased]

### Added

- The transfer list shows where each file goes, such as “Projects → My site”.
- Sort the transfer list by clicking a column heading. Right-click the headings to hide
  or show columns.
- Double-click a column divider in the transfer list to fit the column to its contents.
- Set the most connections a bookmark may open to its server in the Site Manager.

### Changed

- The Concurrent transfers limit now covers all tabs together and applies at once.
- The transfer list shows active transfers first and finished ones last.
- When you send several folders at once, they all appear in the transfer list right away.
- SFTP downloads are faster.
- Transfers start sooner, without waiting for every extra connection to log in.
- Dropping many files at once starts faster.

### Fixed

- Sending the same file or folder to several servers at once no longer fails with
  “Command failed”.
- Stopping an FTP upload takes effect at once and leaves no half-sent file behind.
- Files whose names start with a dot now show up on FTP servers, and folders that contain
  them can be deleted.
- FTP and FTPS uploads no longer ask to replace a file that isn’t there.
- Creating folders over FTP works on accounts that may create folders but not open them.
- If a server turns away extra connections, FTPeach carries on with the ones it has and
  tries again a little later.
- A transfer now fails instead of finishing with a file of the wrong size.
- The connection log no longer shows an error when an FTP server declines an optional
  feature.
- Folder uploads to WebDAV can no longer be paused, because resuming started the file over.
- Resume all works while a WebDAV transfer is still running.
- Unavailable Pause and Retry buttons no longer light up under the pointer.
- Saving a connection as a bookmark renames its pane and tab to match.
- The “Connect first” hint is easier to read.
- A finished transfer always shows 100%.

## [0.1.2] - 2026-09-10

### Added

- Pause and resume transfers. A paused download carries on from its partial file on every
  protocol. A paused upload over FTP, FTPS or SFTP carries on from what already reached the
  server once those bytes are checked against the local file; otherwise it starts over, and
  the connection log says why.
- Pause and resume folder transfers in every direction except copies between two servers.
  Files already delivered from an unchanged source are not sent again, and the file the
  pause cut short carries on where it stopped.
- Drop files and folders from Explorer onto the Computer pane, and drag a local selection
  out onto Explorer or the desktop. Dragging out always copies and never moves.

### Changed

- Check for updates as FTPeach starts and download them right away. A downloaded update
  installs silently, with no installer window, the next time FTPeach starts — or at once
  from **Install update** in the status bar.
- Name each transfer’s direction after where its bytes go — upload, download, copy between
  servers, copy on the server or copy on this computer — in its icon, label and tooltip.
- Refuse a drop onto a Server pane that is not connected, with a **Connect first** hint in
  the pane, instead of accepting it and failing with a connection error.

### Fixed

- Honor the uninstaller’s “delete the application data” checkbox: ticking it now removes
  %APPDATA%\FTPeach (settings, sites, known hosts, saved session, logs and the
  vault), and leaving it unticked keeps that data for a reinstall. Updates never delete it.
- Open a bookmark’s starting folder when reconnecting from the pane’s own Connect button,
  instead of the root folder.
- Stop labeling a pane, its tab and its transfers with a bookmark’s name after the
  connection form has been edited by hand.
- Grey out Retry for transfers whose connection has been closed, instead of letting them
  fail with “No active connection”, and stop blaming the server for a listing that arrives
  after a deliberate disconnect.
- Ask once, not twice, before overwriting an existing file.
- Show a folder upload’s progress while it runs, instead of “0 B / 0 B” until it finishes,
  and list its files in the Server pane as they arrive.
- Keep a finished folder transfer from falling back to in progress with Stop stuck on
  “cancelling”.
- Remove the folders a stopped folder transfer created, not just its files, along with
  partial downloads and upload staging files — and never anything that was there before.
- Show a folder dragged out to Explorer as a single row with its real size, instead of a
  row per file and a folder row stuck at 0 B.
- Remove the `.ftpeach-resume.json` record next to a file once its download completes.

## [0.1.1] - 2026-09-09

### Changed

- Open the full site editor when saving a connection or local path, with a folder selector for organizing bookmarks.
- Refine panel, tab, dialog and menu styling, and use theme colors for text selection.

### Fixed

- Correct translations and plural forms across supported languages, with checks for missing plural forms and unknown translation keys.
- Resolve sRGB theme colors correctly for the native window frame.

## [0.1.0] - 2026-09-08

### Added

- Initial public version of FTPeach for Windows, with FTP, FTPS, SFTP and WebDAV support.
