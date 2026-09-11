# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow SemVer.

## [Unreleased]

### Added

- The transfer list has a new Route column that shows where each file comes from and
  where it goes, such as “Projects → My site” or “My site → Backup”. Point at it to see
  the full path at both ends. Server names stay in the list after you disconnect.
- In the transfer list, the File column now uses any spare width, and double-clicking
  the divider between two column headings fits the column to its contents.

### Fixed

- Uploading to an FTP or FTPS server no longer asks whether to replace a file that isn’t
  there. If a file with the same name turns up on the server while you upload, FTPeach
  still leaves it alone and tells you.
- The “Connect first” hint, shown when you drop files onto a Server pane that isn’t
  connected, is easier to read.
- Saving the current connection as a bookmark now names its pane and tab after the
  bookmark, instead of leaving the server address there.
- A folder upload to a WebDAV server can no longer be paused, the same as a single file.
  WebDAV can’t continue a file that was cut short, so resuming started that file over.
- The Resume all button in the toolbar works again while a WebDAV transfer is still
  running beside transfers you paused. Before, it stayed greyed out until the WebDAV
  transfer finished.
- The Pause and Retry buttons in the transfer list no longer light up under the pointer
  when they are unavailable, so they no longer look clickable.
- Sending the same file or folder to several servers at once no longer fails with
  “Command failed” for every transfer but the first. When two transfers really do need
  the same file or folder, the message now says so.
- Stopping an upload to an FTP server takes effect at once. Before, the transfer could
  sit on “Cancelling…” for several seconds while the server went on receiving the file.
- A stopped folder upload to an FTP server no longer leaves a hidden, half-sent file
  behind, which kept the folder from being deleted or replaced.
- On FTP servers that hide files whose names start with a dot, FTPeach now shows those
  files, and deleting a folder removes them too. Before, such a folder could look empty
  and still refuse to be deleted.

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
