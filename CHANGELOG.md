# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow SemVer.

## [Unreleased]

### Fixed

- A folder download that contains a name Windows cannot use no longer reports an unexpected error.
- Dragging a server file to Explorer refuses a name like `a:b`, which Windows would not store as
  a plain file, as downloading it already did.
- Downloading a folder refuses a file or folder named like a drive (`d:name`), which Windows
  would have saved outside the folder you chose.
- Connecting to an address that does not exist says the server was not found, instead of
  reporting an unexpected error.
- A file another program has open, a name that is already taken and a full disk each get their
  own message, instead of "not found" or an unexpected error.
- When an FTP or SFTP connection cannot reach the configured proxy, the message says so instead of
  blaming the server.
- Testing a proxy that works no longer reports a failure.
- Showing a bookmark's password when none is saved no longer reports an error.
- Pausing, stopping or skipping files in a copy no longer reports them as not transferred.
- Stopping a folder upload no longer reports "Cleanup is incomplete": the files already uploaded
  stay on the server, and the unfinished one is removed.
- Moving a saved password from an FTPS bookmark to plain FTP is marked as less secure when you are
  asked to confirm it.
- A bookmark saved as FTPS in an older format shows as FTPS instead of FTP, and saving it no
  longer asks to confirm moving its password.
- Locking the vault from Settings now hides a password shown with the eye button.
- The vault no longer locks up to half a minute before the auto-lock time is up.
- "System protection" in Settings says why it cannot be chosen while the vault is locked.
- After a vault reset, the passwords deleted with it are no longer shown as saved.
- Concurrent transfers in Settings can be set up to 128 instead of 10.
- A password entered for a bookmark that was switched from SFTP with a key to another protocol is
  no longer lost when the bookmark is saved.
- Deleting a bookmark while the password vault is locked asks for the master password, instead of
  only reporting that the vault is locked.
- The log of a WebDAV connection warns about an unchecked certificate once instead of twice, and
  not at all for an `http://` address.
- With Windows set to Turkish, opening a local `.inf`, `.msi` or `.iso` file is no longer refused.
- A wrong master password says that the password was not accepted, instead of "Command failed".
- When files are dropped on a folder that cannot be read, the reason is given in your language.
- Settings shows the vault as unlocked as soon as it is unlocked from a security confirmation or
  the unlock prompt, and the auto-lock time is counted from that moment.
- A proxy can be switched off and its fields emptied in one save.

## [0.3.0] - 2026-09-27

### Added

- Open with… asks which program to open the file with, instead of always using the default one.
- Open in a server file's menu opens it with its usual program, like a double click.
- Dragging files with the right mouse button asks whether to copy or move them.
- The first connection to an SSH server shows its key fingerprint and asks before trusting it.
  The new "Confirm a new SSH server key" setting turns this off.
- A shortcut used by another action shows a warning icon; its tooltip names the other actions,
  and clicking it goes to the first one.
- After exporting or importing settings, the status bar says what was exported or imported and
  how many bookmarks were added or skipped.

### Changed

- Dragging files to another disk copies them, as in Windows Explorer. Hold Shift to move them.
- Files can be moved only on your computer or within one server connection. Between your
  computer and a server, or between two servers, copy them instead.
- Quitting with edits that have not been uploaded asks whether to go back or keep them for later.
  The changed-file dialog has a Later button.
- When several files opened in other applications change at once, FTPeach asks about each one.
- The bookmark editor is tidier: a saved password is changed with its edit button, and encoding,
  start folder and connection limit are under Advanced settings. It also fits a small window.
- The status bar shows transfers in orange, disconnected in grey, and red only for a failed
  connection.
- In a narrow window, the status bar shortens its texts instead of cutting them off and shows
  the full text in a tooltip.
- A file pane too narrow for its columns scrolls sideways instead of cutting off the last column.
- Resizing the window is smoother on Windows, with reduced black edge artifacts and no
  flashing white line in the verified multi-monitor setup.
- Animations play even when Windows animation effects are turned off.
- Screen readers read out the names of icon buttons, connection fields and search boxes, and
  Tab stays inside the dialog on top.
- New texts are translated into every language.
- Many open tabs keep more of their names and scroll sooner, and every tab shows its close button
  on hover.

### Security

- Downloaded files are marked as coming from the internet, like browser downloads, so Windows
  and Office check them before they open or run.
- Trusting a changed SSH server key is confirmed in FTPeach's own window, which shows the old
  and the new key side by side.
- A WebDAV address starting with http:// no longer sends the password unencrypted unless you
  allow it.
- A WebDAV address can no longer contain a user name, a password or a query string.
- A connection set up without a proxy no longer uses a proxy from Windows environment variables.
- Saved passwords lock when Windows locks or the window is minimized or hidden, even with the
  auto-lock timer off.
- Open with asks before running a server file that is a program or script.
- Turning off security confirmations or relaxing the automatic lock asks for confirmation
  and the master password when one is set. Turning off enhanced protection always asks for
  the master password.
- Changing a bookmark's server, port, user or encryption asks before the saved password is used
  for the new address.
- Backups of bookmarks and settings no longer keep old or unencrypted passwords.
- A downloaded update can no longer be swapped or replaced by an older version before it
  installs.
- An FTP server can no longer fill memory with an endless reply, and in active mode files are
  accepted only from the server itself.
- A proxy password that cannot be encrypted is reported as an error, and the old one is kept.
- A password shown with the eye button no longer appears in another bookmark or after the
  vault locks.

### Fixed

- New file works over FTP and FTPS without emptying an existing file.
- Creating a file with a name that is already taken says so instead of showing a general error.
- Renaming, moving or downloading a file no longer replaces an existing one unless you agree.
- Changing only the letter case of a local file name no longer fails.
- A failed copy no longer leaves a half-written file behind or damages the file it was replacing.
- Copying or moving several files says how many failed, and a cut stays on the clipboard until
  its files have really moved.
- One failed file no longer stops the rest of a batch.
- Changes to a file opened in another application are no longer lost if FTPeach closes first;
  FTPeach offers them at the next start.
- Uploading from the changed-file dialog no longer asks to overwrite twice.
- Resuming a paused transfer no longer asks again whether to replace the file.
- Copying thousands of files shows one notification at the end instead of many.
- Stop all also stops files of a large selection that have not started yet.
- Deleting a deeply nested folder on an FTP or SFTP server removes all of it.
- An error from deleting files on a server stays visible.
- An FTP server refusing a data connection no longer makes the pane look disconnected.
- A dropped FTP or SFTP connection is reported as a lost connection instead of an unknown error.
- A busy or full server is reported as such instead of an unknown error.
- A resumed WebDAV download no longer mixes old and new content.
- After accepting a new SSH server key, FTPeach signs in with the saved password.
- The protocol log says when FTP active mode is skipped because of a proxy.
- A proxy given as an IPv6 address works for WebDAV, and a proxy address with a port, path or
  user name in it is refused.
- A damaged settings or bookmarks file no longer replaces its backup or fills the disk.
- Quitting or installing an update saves the latest settings and tabs first.
- Tabs that could not be saved are reported right away.
- Importing bookmarks without settings no longer reports an error, and they appear right away.
- Selecting files with a rectangle in a long folder selects every file inside it, and
  Shift+click after re-sorting extends from the right file.
- Alt+Left and Alt+Right work right after clicking a folder in the path bar.
- Files cut with Ctrl+X look paler until they are pasted.
- Tabs show their whole name when there is room.
- Bookmark and tab icons keep their size next to a long name.
- The bookmark manager's buttons fit a narrow window at a large interface scale.
- Refresh in a pane's menu no longer shows F5, which refreshes both panes.
- An empty folder scrolls sideways like a full one.
- A narrow pane no longer cuts off the port field.
- The More and bookmark menus stay inside a small window.
- The log's filter menu stays open while you tick several kinds.
- Long tooltips wrap instead of being cut off, and the date and time lists fit their names.
- Check for Updates says when FTPeach is already up to date.
- Help → Documentation and the license link in About work.
- Switching languages quickly no longer leaves an earlier language on screen.
- Errors from opening a file in another application are shown in your language.
- Security questions use the language just picked in settings, and cancelling one no longer
  shows an error.
- The security confirmation window follows the theme and opens centered over FTPeach.
- A master password that is too short or does not match is reported in red.
- The warning about a shortcut in use names the pane instead of showing `{{side}}`.
- Program paths no longer show `\\?\` in front.

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
