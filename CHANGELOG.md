# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow SemVer.

## [Unreleased]

### Changed

- Creating a new empty file over FTP or FTPS now reports that safe creation is
  unavailable, instead of risking replacement of an existing file. Use SFTP or WebDAV.
  On those servers New file is shown as unavailable with the reason, instead of asking
  for a name first.

- Files can be moved only on your computer or within one server connection. Between your
  computer and a server, or between two servers, copy them instead.
- Quitting with edits that have not been uploaded now asks whether to return or keep the
  copies for recovery and exit. The changed-file dialog offers Later to defer an upload.
- Turning off security confirmations now asks right away, when you clear the setting,
  rather than when you save. Cancelling leaves the setting on.
- Security questions are now written in the language you have just picked in settings,
  even before you save it.
- Cancelling a security question no longer leaves an error message on screen.
- The "Show security confirmations" description now says exactly what the setting turns
  off, and which questions are always asked.

### Security

- Open with now asks before running a server file whose saved name makes it a program or
  script, and the first time a program typed into settings opens a file.
- Turning off security confirmations or relaxing the vault's automatic lock now asks for
  confirmation in a separate window, and for the master password when one is set.
- Turning off enhanced protection always asks for the master password, even while the vault
  is unlocked.
- Changing a bookmark's or the proxy's server, port, user or encryption now asks before the
  saved password is used for the new address, and warns if the connection becomes less secure.
- Backup copies of bookmarks and settings no longer keep passwords that were moved into
  the vault, changed or deleted, and never keep unencrypted passwords.
- A downloaded update can no longer be swapped for another file before it installs, and an
  older installer can no longer be passed off as a newer version.
- An FTP server that answers with an endless reply is disconnected instead of filling
  memory, and in active mode files are accepted only from the server itself.
- A proxy password that cannot be encrypted is reported as an error instead of a saved
  setting, and the password saved before is kept.
- A saved password shown with the eye button no longer appears in another bookmark's field
  or over a password just typed, and never after the vault locks.

### Fixed

- Quitting or installing an update now saves the latest settings and tabs before
  closing, including changes still waiting for their save timer.

- A busy protocol log no longer builds an unlimited queue behind a slow disk. It
  reports dropped messages and drains pending records before quitting when the disk responds.

- Failed local copies now wait for outstanding disk writes before removing their temporary
  files, including after cancellation or a full disk.
- Editor copies survive temporary-folder cleanup and retain later saves when an editor
  keeps a file locked during shutdown. New editor opens pause when retained copies reach
  1 GiB or 30 days; existing edits are never automatically deleted.

- Copying or moving several files now says how many did not make it, and a move that could
  not finish says the originals are still in place. A cut stays on the clipboard until its
  files have really moved.
- A failed file in a batch no longer ends the batch while other files are still being
  written, and very large selections are started in batches instead of all at once.
- Tabs that could not be saved are now reported right away instead of coming back wrong at
  the next launch, and the newest tab state is always the one stored.
- Remote renames, including letter-case changes, only replace an existing file after confirmation.
- Changing only the letter case of a local file name no longer fails as busy.
- Uploading from the changed-file dialog no longer asks for overwrite confirmation twice.
- Download commits now refuse to replace existing files unless overwrite was explicitly allowed.
- Renaming or moving a file into a folder no longer replaces a file with the same name there
  unless you agreed to overwrite it.
- A failed copy of a single file no longer leaves a half-written file behind or damages the
  file it was about to replace.
- Changes to a file opened in another application are no longer lost if FTPeach closes before
  they are uploaded. They are kept, and FTPeach offers them the next time it starts.
- When several files opened in other applications change at once, FTPeach now asks about each
  of them.
- Saving again in the editor while the previous upload is still running no longer produces a
  question that cannot be answered; FTPeach asks once the upload has finished.

## [0.2.3] - 2026-09-22

### Added

- If file names on an FTP server look garbled, you can pick another encoding for its bookmark,
  such as Windows-1251 for Cyrillic.
- You can log in to SFTP servers that ask for the password in a separate prompt.

### Changed

- With enhanced protection on, the proxy password is protected by the master password too.

### Fixed

- Opening a file the server refuses no longer hangs.
- Uploads over FTPS no longer fail on some servers.
- Choosing the wrong kind of FTPS for a server now fails quickly with a clear message.
- Logging in with an RSA key works on up-to-date SFTP servers.
- Renaming a file to a name that is already taken no longer silently replaces the other file.
- WebDAV works through SOCKS4 proxies, and file names with `&` work on WebDAV.
- On Windows (IIS) servers, file names starting with a space keep it, and a missing file is
  reported as not found.
- A file you aren't allowed to open on a WebDAV server says access is denied instead of
  reporting a failed login.
- A full disk on the server is reported as such instead of a lost connection.
- Exported bookmarks with a connection limit can be imported again.
- Dragging bookmarks in the bookmark manager puts them where you drop them.
- The bookmark manager works fully from the keyboard, and Escape in its fields no longer
  closes it.
- Long translations, such as Greek or German, no longer run off the edge in Settings.

## [0.2.2] - 2026-09-14

### Added

- The tray icon's menu shows how transfers are going and lets you pause them or lock saved
  passwords.
- From the tray icon's menu you can change the speed limit, keep the computer awake, turn
  transfer notifications on or off, and connect to a recent site.
- If transfers are still running when you quit, FTPeach asks whether to quit right away or
  once they finish.
- The tray menu shows the current transfer speed alongside transfer progress.

### Fixed

- File → Exit quits the app instead of leaving a blank window or hiding it to the tray.
- A custom speed limit appears directly below No limit in the tray menu.
- Closing Settings no longer overwrites settings changed from the tray while it was open.

## [0.2.1] - 2026-09-13

### Added

- Drop files onto any folder in the address bar to copy or move them there, including files
  dragged in from Explorer.
- While you drag files, the cursor shows whether they will be moved or copied.

### Changed

- Dragging files to another folder on the same computer or the same server now moves them,
  while dragging between the computer and a server copies them. Hold Ctrl to copy or Shift
  to move.
- Moving a file to another drive checks the copy before the original is deleted.
- Settings and the bookmark editor ask whether to save your changes when you press Escape or
  click outside them, instead of closing and losing the changes.
- The transfer list stays fast with thousands of transfers, and filtering a large folder is
  quicker.
- Adding transfers to a full queue shows a message instead of slowing FTPeach down.
- The transfer list shows the File column before Route again in a new or reset layout.

### Fixed

- Replacing an existing file works on SFTP servers and on servers that don't replace files on
  their own.
- When a file with the same name already exists on the server, the error message says so.
- Pressing Stop no longer reports that the connection to the server was lost.
- Stopping a folder transfer keeps the files it can't confirm it created, and tells you so.
- A paused folder transfer no longer resumes over files that changed in the meantime.
- Disconnecting from a server that stopped responding no longer hangs.
- A local folder with files FTPeach can't read shows an error instead of listing them as
  empty files.
- Switching folders quickly no longer shows the contents of a folder you already left.
- The tray icon appears only while FTPeach is hidden to the tray.
- When one window is open on top of another, Escape closes only the top one.
- Dragging files over a disconnected pane no longer highlights its connection options.
- The scroll bar in the language list in Settings can be dragged without closing the list.
- Chinese language names line up with the other languages in right-to-left layouts.

## [0.2.0] - 2026-09-12

### Added

- The transfer list shows where each file goes, such as “Projects → My site”.
- Sort the transfer list by clicking a column heading, right-click the headings to hide or
  show columns, and double-click a divider to fit a column to its contents.
- Set the most connections a bookmark may open to its server in the Site Manager.
- Search the log, and choose which kinds of messages it shows by Filter button.
- Reopen closed tabs with Ctrl+Shift+T, starting with the last one you closed.

### Changed

- The Concurrent transfers limit now covers all tabs together and applies at once.
- The transfer list shows active transfers first and finished ones last.
- When you send several folders at once, they all appear in the transfer list right away.
- Transfers start sooner, SFTP downloads are faster, and dropping many files at once gets
  going quicker.
- The log records, and can be written to a file, even while its panel is closed, so opening
  it shows what already happened.
- The log keeps more lines and shows the time of each one by default, to the millisecond
  and in your time format. You can turn the times off in Settings.
- Log files are named by date, name the server, and old ones are removed once they take
  too much space.
- The notification shown when transfers finish counts the files in plain words, such as
  “8 files transferred, 2 files failed”.
- The diagnostic bundle includes the recent log and the app's own error log.
- Translations in every language are clearer and match what each button and setting does.

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
- A finished transfer always shows 100%.
- The connection log no longer shows an error when an FTP server declines an optional
  feature.
- Folder uploads to WebDAV can no longer be paused, because resuming started the file over.
- Resume all works while a WebDAV transfer is still running.
- Saving a connection as a bookmark renames its pane and tab to match.
- The notification shown when transfers finish now comes from FTPeach, with its name and
  icon, instead of appearing to come from Windows PowerShell.
- Transfer speeds no longer dip while other transfers run, and no longer creep up from
  0 B/s when a transfer starts.
- Showing the log no longer waits for a connection that is stuck, and its lines no longer
  come out of order during busy transfers.
- Reset Layout and Cache no longer opens or closes the log.
- Menus, tooltips and panels now fit what is written in them, so nothing fades out, wraps
  or is pushed out of sight — including the Manage Bookmarks button in a disconnected pane.
- Many smaller touches around the window: steadier buttons and lists, a clearer “Connect
  first” hint, and the log's Filter button beside the search.

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
- Remove the leftover resume file next to a downloaded file once the download completes.

## [0.1.1] - 2026-09-09

### Changed

- Open the full site editor when saving a connection or local path, with a folder selector for organizing bookmarks.
- Refine panel, tab, dialog and menu styling, and use theme colors for text selection.

### Fixed

- Correct translations and plural forms across supported languages.
- The window frame uses the right theme colors.

## [0.1.0] - 2026-09-08

### Added

- Initial public version of FTPeach for Windows, with FTP, FTPS, SFTP and WebDAV support.
