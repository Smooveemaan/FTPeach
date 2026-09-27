# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow SemVer.

## [Unreleased]

### Changed

- Resizing the window is smoother on Windows, with reduced black edge artifacts
  and no flashing white line in the verified multi-monitor setup.
- The embedded browser background follows the selected theme; text-edge fades
  refresh shortly after resizing settles.

- Dragging files to another disk now copies them, as in Windows Explorer. Hold Shift to move
  them instead.
- Dragging files with the right mouse button now asks whether to copy or move them.
- New file now works over FTP and FTPS without replacing or truncating existing file contents.
- Files can be moved only on your computer or within one server connection. Between your
  computer and a server, or between two servers, copy them instead.
- Quitting with edits that have not been uploaded now asks whether to return or keep the
  copies for recovery and exit. The changed-file dialog offers Later to defer an upload.
- The bookmark editor is tidier: a saved password is changed with its edit button, and
  encoding, start folder and connection limit sit under Advanced settings.
- The bookmark editor fits and scrolls in a small window.
- A file pane too narrow for its columns scrolls sideways instead of cutting off the last
  column.
- In a narrow window, the status bar hides the pane file counts while files are
  transferring, and an update's install button always stays whole.
- The status bar shows transfers in orange, and no longer turns yellow while files are still
  transferring. Disconnected is grey; red now means only a failed connection.
- After exporting or importing settings, the status bar says what was exported or imported and
  how many bookmarks were added or skipped as duplicates.
- When the status bar runs short of room, it shortens its texts instead of cutting them off,
  and shows the full text in a tooltip.
- Animations play even when Windows animation effects are turned off. Error messages that
  fade out no longer vanish at once in that case.
- The Copy here and Move here menu, the bookmark editor's connection limit and advanced
  settings, and the import and export messages are translated into every language.

### Security

- Downloaded files are now marked as having come from a server, the same way a browser
  marks a download. Windows SmartScreen, Office Protected View and script hosts read that
  mark, so a document from the internet opens in Protected View and a downloaded program
  is checked before it runs. The mark records the address without your user name or
  password, survives the file being renamed or a download being resumed, and needs NTFS.
  A server on your local network is marked as the intranet instead.
- The first connection to an SSH server now shows its key fingerprint and asks before
  trusting it, so you can compare it with the one the server's administrator gave you.
  The new "Confirm a new SSH server key" setting turns this off, and turning it off asks
  for confirmation like the other protective settings.
- Trusting a changed or new SSH server key is now confirmed in FTPeach's own window, which
  shows the key trusted until now next to the one offered. If the stored key changes while
  you are deciding, the decision is asked again instead of being applied to the new key.
- A WebDAV address that starts with http:// no longer sends the password before the
  connection is encrypted. FTPeach looks for an https:// address first, and asks you to
  tick "Allow unencrypted sign-in" if the server insists on a password in the clear.
- A WebDAV address may no longer contain a user name, a password or a query string; put
  the account in the user and password fields.
- A connection set up without a proxy no longer follows a proxy named in Windows
  environment variables.
- The vault now locks when Windows locks or the FTPeach window is hidden, even with the
  auto-lock timer turned off, and it does so even if the window has stopped responding.
  Settings and the unlock prompt now say what a lock leaves running.
- Open with now asks before running a server file whose saved name makes it a program or
  script, and the first time a program typed into settings opens a file.
- Turning off security confirmations or relaxing the vault's automatic lock now asks for
  confirmation in a separate window, and for the master password when one is set.
  Cancelling leaves the setting as it was.
- Security questions are now written in the language you have just picked in settings,
  even before you save it.
- Cancelling a security question no longer leaves an error message on screen.
- The "Show security confirmations" description now says exactly what the setting turns
  off, and which questions are always asked.
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

- Resuming a paused transfer no longer asks again whether to replace the file.
- Copying thousands of files shows one notification when all of them are done, instead of one
  every few dozen files. Pausing no longer shows a notification.
- An FTP server refusing a file's data connection no longer makes its pane look
  disconnected.
- Deleting a deeply nested folder on an FTP or SFTP server removes all of it, not only the
  first 40 levels.
- An error from deleting files on a server stays visible instead of vanishing right away.
- Saved passwords lock as soon as the window is minimized or hidden to the tray, and within a
  second of Windows locking, instead of up to five seconds later.
- The security confirmation window follows the light theme and opens centered over the
  FTPeach window.
- The More and bookmark menus stay inside a narrow or scaled-up window, and scroll when it is
  too short for them.
- A master password that is too short or does not match its confirmation is reported in red,
  and the message fades out after a moment.
- Tabs show their whole name when there is room for it.
- Files and folders cut with Ctrl+X look paler until they are pasted.
- The log's filter menu stays open while you tick several kinds, and closes on a click outside
  it.
- Check for Updates says in the status bar when FTPeach is already up to date.
- Alt+Left and Alt+Right work right after clicking a folder in the path bar.
- Stop all also stops the files of a large selection that have not started yet.
- A narrowed pane no longer cuts off the port field of its connection form.
- Importing bookmarks without application settings no longer reports an unexpected error, and
  the imported bookmarks appear right away.
- Help → Documentation opens the user documentation, and the license link in About works.
- The warning about a shortcut already in use names the pane of the other action instead of
  showing `{{side}}`.
- The question before running a program on your computer shows its usual path, without
  `\\?\` in front.
- The protocol log strikes through only the name of a closed connection, not the colon.
- While you type a new password for a saved bookmark, the hint below says it will be saved.
- A selection rectangle that runs past the edge of the file list no longer shows a border
  there, so it no longer looks as if the selection ends at the edge.
- Dragging files in from Explorer follows the pointer more smoothly.
- The date and time format lists in Settings are wide enough for their translated names.
- A long tooltip, such as the plain FTP warning in French or Greek, gets a third line
  instead of being cut off.
- An error while opening a file in another application is shown in your language.
- After you accept a new or changed SSH server key, FTPeach now signs in with the bookmark's
  saved password instead of reporting a wrong username or password.
- A resumed WebDAV download no longer mixes old and new content when the file on the server
  was replaced within the same second; such a download now starts over.
- A connection that drops in the middle of an FTP or SFTP transfer is now reported as a lost
  connection instead of an unknown error or a timeout, and SFTP now waits only as long as
  the timeout set for the site.
- A server that turns a connection away because it is busy or full is now reported as such
  (WebDAV 429 and 503, an FTP server refusing at the greeting) instead of an unknown error.
- The protocol log now says when FTP active mode is not used because the site connects
  through a proxy.
- Creating a local file with a name that is already taken now says so, instead of showing a
  general error.
- The same now applies to new files on SFTP and WebDAV servers, including a file someone else
  created a moment earlier.
- Switching languages quickly, or cancelling a language preview while it loads, no longer
  leaves an earlier language on screen or the text running the wrong way.
- Icon buttons, the connection fields and the search boxes now have names a screen reader
  reads out, and the pause button in the transfer list is called Pause instead of Paused.
- While a dialog is open, Tab and the screen reader stay inside the topmost dialog and skip
  hidden fields; the window can still be moved and closed.
- With Windows animations turned off, FTPeach no longer animates either.
- Selecting files by dragging a rectangle in a long folder now selects every file inside it,
  including ones scrolled past, and shrinking the rectangle or holding Ctrl no longer leaves
  or drops the wrong files. Shift+click after re-sorting extends from the file you clicked.
- A proxy given as an IPv6 address, with or without square brackets, now works for WebDAV
  as it does for FTP and SFTP. A proxy address with a port, a path or a user name in it is
  refused when the settings are saved.
- A damaged bookmarks, local paths or settings file no longer replaces its last good
  backup, and opening it again no longer fills the disk with copies of it.
- Quitting or installing an update now saves the latest settings and tabs before
  closing, including changes still waiting for their save timer.
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
