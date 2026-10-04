# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow SemVer.

## [Unreleased]

### Added

- The portable zip has `keys` and `certificates` folders, and the key and certificate pickers open
  there.
- Settings → Logging can write the log files to a folder of your choice, and opens the log folder.
- Settings → Password protection can unlock the vault with Windows Hello.
- Showing a saved password, and other actions that ask for the master password, can be confirmed
  with Windows Hello where it is enabled; the master password still works.
- Page Up and Page Down move through the file list a screen at a time; with Shift they select.
- The … in the path bar opens a list of the folders it hides.
- Nine more colors for bookmarks.

### Changed

- Ctrl+N starts a new connection in the left pane and Ctrl+Shift+N in the right one; File has an
  item for each. A pane that is in use asks before it is disconnected.
- "Allow system unlock" says why it cannot be turned on while the vault is locked, and says that
  Windows is creating the Windows Hello key while it is being turned on.
- Duplicate in Manage Bookmarks makes the copy at once, named "Name (2)", "Name (3)" and so on,
  instead of opening an editor with "(copy)" added to the name.
- The FTPeach icon and the tray icon are the peach on its own, without the square background, so
  they stand out on a light taskbar too.
- A bookmark's icon and color menus open scrolled to the one that is chosen.
- The hint under "Auto-lock after, min" is one short paragraph, and "System protection" says why
  it cannot be chosen while the vault is locked.
- Help → Report an Issue lets you choose between a bug report, a feature request and a
  translation fix.
- The message about saved passwords that could not be read no longer says it happened after an
  update: it also appears after moving the portable copy to another computer.

### Fixed

- In Arabic and Hebrew, sizes, dates, speeds and times read left to right ("39 B", not "B 39"),
  the log keeps a space between the time and the connection, and the protocol in Recent
  connections is no longer cut off at its start.
- A file too large for a WebDAV server, a server with no free connections and other limits say
  that a limit was reached, instead of "The provided value is invalid".
- Check Now in a portable copy says there is no update, instead of "Couldn't check for updates",
  while the latest release has no portable package.
- The hint for "Write log to file" no longer names the installed copy's folder in a portable copy.
- The "File changed" question says that Later asks again the next time the file is saved.
- When the connection to a server is lost or stops answering, the pane says so and offers to
  connect again, instead of still looking connected and failing every action.
- A folder with a junction or symbolic link inside can be moved or renamed on the same disk.
- Saving a bookmark that moves its password while the vault is locked asks for the master
  password first and whether to move the password only once.
- A bookmark with no port and one with the default port are recognised as the same server.
- Pausing or resuming a transfer leaves its row where it is in Transfers.
- The notification at the end of a big transfer counts every file, not at most 1000.
- Files dragged out to Explorer one after another give one notification, not one each.
- Changing the protocol of a connection or a bookmark changes a default port to the new
  protocol's, and an empty port field shows which port will be used; a port of your own stays.
- The address field of a bookmark takes at most 255 characters, the longest a server name can be,
  instead of refusing the bookmark when you save it.
- Dragging a column header in a list scrolled sideways moves the column to where you drop it,
  instead of several columns further.
- Renaming a file with F2 selects its name without the extension, as Explorer does.
- Sweeping a selection rectangle past the end of a long list scrolls faster the further you go.
- The Date modified and Date created columns are wide enough for a date with a 12-hour time.
- After closing a dialog opened from the menu, Ctrl+A selects files instead of the text of the
  window.
- Settings → Shortcuts warns when a global shortcut and a file pane shortcut use the same keys.
- Renaming a file on an FTP or SFTP server to the same name in other letter case works instead
  of failing with "An unexpected error occurred".
- A server that turns you away because it already has its maximum number of users says so,
  instead of reporting that the connection was unexpectedly closed.
- Importing a file that is not FTPeach settings says so, instead of "EOF while parsing a
  value".
- A missing key or certificate file is named by its path when connecting, instead of "File or
  folder not found".
- A network folder that was not chosen with Choose folder… is refused with a message that says
  how to open it, instead of "You don't have permission".
- A WebDAV address with a user name, a password, ? or # in it says what to change, instead of
  "The provided value is invalid".
- An invalid mode in SFTP permissions is shown in the dialog, which stays open with what you
  typed.
- The log names the reason a WebDAV connection failed, and says when FTP uses active mode.
- Errors about the master password and the proxy test stay on screen until you try again or
  change the field, instead of fading out after two seconds.
- The proxy test result goes away when a proxy field changes, and the settings no longer jump
  when a test starts.
- The warning about RSA keys in Manage Bookmarks spans the whole dialog instead of a narrow
  column under the passphrase.
- Opening a bookmark in a pane connected to a WebDAV server names that server in the question
  instead of showing empty quotes.
- A folder of thousands of small files goes to a server much faster and no longer loads the
  computer and the server more with every file.
- Files in very deeply nested folders, whose full path is longer than 260 characters, download
  instead of failing with "File or folder not found".
- While a file downloads, other downloads, copies, moves, deletes and new local folders or
  files no longer wait for it to finish, and stopping a folder no longer hangs on "Cancelling".
- Stopping a folder download, also once paused, removes the file it was in the middle of
  instead of keeping it and reporting "Cleanup is incomplete".
- Pausing or stopping a folder transfer just as a file finishes no longer makes the resume
  fail with "A file or folder with that name already exists", or the stop leave the folder
  behind with "Cleanup is incomplete".
- Moving a folder with files over 1 MB to a disk without the NTFS change journal, such as a
  USB stick, removes the original instead of failing with "Command failed"; resuming or
  stopping transfers there works with big files too.
- A folder transfer resumed after its files changed on the server says that files changed,
  instead of that the transferred file failed the integrity check.
- A folder copy leaves out the working files other transfers keep beside their files
  (`.ftpeach-….part` and resume records) instead of copying them along.
- Stopping a file download, also once paused, removes the partly downloaded file instead of
  leaving it and its resume record behind.
- A folder that is gone from the server no longer drops the connection when a paused folder
  transfer is resumed.
- Folders of more than 10 000 files on a server can be opened, filled and deleted.
- Deleting a big folder on an FTP server that lists only part of it at a time removes it whole
  instead of failing with "Directory not empty".
- A folder's row in Transfers no longer flickers between Queued and Upload, Download or Copy,
  and keeps showing its speed and time remaining, while it transfers many small files.
- The pane a transfer goes to no longer jumps back to the folder it started in, or loses its
  selection, while the transfer runs.
- A refreshed folder keeps the selection of the files that are still there.
- A file that finishes quickly shows its real size in Transfers, also after it changed on the
  server.
- A path pasted with quotes, as Explorer's "Copy as path" gives it, opens in the path bar.
- Opening FTPeach's own data folder is refused with a clear message instead of "An unexpected
  error occurred".
- Several files copied from one server to another wait their turn instead of failing with
  "Relay requires two available workers".
- A folder, or a file dragged out to Explorer, reads Queued in Transfers while it waits for
  its turn, instead of looking as if it were already being transferred.
- Copying from one server to another runs at the full speed limit instead of half of it.
- A changed Concurrent transfers limit applies at once again, not only after a restart.
- A security confirmation no longer adds a second FTPeach button to the taskbar.
- A file opened with an external application whose download was cut short no longer shows up
  in "Edits that were not uploaded" as `.part` and `.ftpeach-resume.json` files.

## [0.4.0] - 2026-10-02

### Added

- A portable version: unpack the zip and run it. Settings, bookmarks and passwords stay in its
  folder, and it updates itself.
- The right-click menu has Cut and Copy for files, Paste in a pane's empty space, and Open for
  files on your computer.
- The right-click menu sends a folder, or everything selected, to the other pane.
- The "…" in a path that does not fit the pane can be clicked to open the nearest folder it hides.

### Changed

- Concurrent transfers in Settings can be set up to 128 instead of 10.
- The right-click menu follows the order of the Windows Explorer menu.
- With a server in both panes, the File menu offers Disconnect for each side.
- Save Connection in the Bookmarks menu works before you connect, like the button beside the
  connection form.
- The Move to dialog is as wide as its folder names need.
- "System protection" in Settings says why it cannot be chosen while the vault is locked.
- A settings file that cannot be imported says what is wrong with it.

### Security

- Downloading a folder refuses a name like `d:name`, which Windows would have saved outside the
  folder you chose.
- Dragging a server file to Explorer refuses a name like `a:b`.
- Moving a saved password from an FTPS bookmark to plain FTP is marked as less secure when you
  confirm it.
- Locking the vault from Settings hides a password shown with the eye button.

### Fixed

- After the vault is moved to another computer, Windows Hello unlock can be switched on there; the
  switch no longer gets stuck.
- Connecting to an address that does not exist says the server was not found.
- When the proxy cannot be reached, the message says so instead of blaming the server.
- Testing a proxy that works no longer reports a failure.
- A proxy can be switched off and its fields emptied in one save.
- With a timeout of a few seconds, a server that stops answering is reported sooner.
- The log of a WebDAV connection warns about an unchecked certificate once, and not at all for an
  `http://` address.
- With several FTP transfers starting at once, one of them no longer fails now and then.
- Pausing, stopping or skipping files in a copy no longer reports them as not transferred.
- Stopping a folder upload keeps the files already uploaded and no longer reports "Cleanup is
  incomplete".
- A folder download that contains a name Windows cannot use no longer reports an unexpected error.
- Copying a folder onto a file of the same name, or a file onto a folder, no longer asks to
  replace it: it says which name is taken and copies the rest.
- A file another program has open, a name that is already taken and a full disk each get their
  own message.
- Renaming a file on your computer to another file's name asks whether to replace it.
- Creating a file on your computer with the name of an existing folder says that the name is
  taken.
- With Windows set to Turkish, opening a local `.inf`, `.msi` or `.iso` file is no longer refused.
- A bookmark saved as FTPS in an older format shows as FTPS, and saving it no longer asks to
  confirm moving its password.
- A bookmark switched from SFTP with a key to another protocol keeps the password entered for it.
- A bookmark whose start folder has no leading slash (`pub`) connects and opens that folder.
- A bookmark with a server name too long to connect to is refused when it is saved.
- Showing a bookmark's password when none is saved no longer reports an error.
- When a saved password cannot be read on this computer, connecting says so and asks for it again.
- A wrong master password says that it was not accepted instead of "Command failed".
- The vault no longer locks up to half a minute before the auto-lock time is up.
- Settings shows the vault as unlocked as soon as it is unlocked anywhere, and the auto-lock time
  counts from that moment.
- After a vault reset, the passwords deleted with it are no longer shown as saved.
- Deleting a bookmark while the vault is locked asks for the master password.
- Keyboard shortcuts no longer act on the panes behind Settings, the bookmark manager and other
  dialogs, and Settings no longer opens underneath the bookmark manager.
- The translations were corrected in every language: wording, grammar and punctuation.

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
