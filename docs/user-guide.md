# User guide

What FTPeach does in the situations where it matters most: a transfer that
stops halfway, a file that already exists, a server you have not seen before.
Behavior statements link to automated checks or recorded manual runs. These
checks cover the conditions they exercise, including the limits described below.

For installing FTPeach and the list of supported protocols, see the
[README](../README.md). For what changed between versions, see the
[changelog](../CHANGELOG.md).

## Appearance

In Settings > Interface, choose a color scheme independently of the light, dark or
system theme. The default Peach is always first, followed by neutral shades through
warm, green, blue and purple hues: Onyx, Ash, Graphite, Linen, Sand, Cocoa, Ember,
Clay, Grass, Forest, Lagoon, Frost, Ocean, Midnight, Bluebell, Orchid, Plum,
Burgundy and Rose. Older settings keep their chosen palette; settings with
no palette keep Peach. Changes preview immediately, Save keeps them and Cancel
restores the previous scheme.

<!-- verified-by: pr test/component/settings/settingsDialog.test.tsx::previews and saves a palette independently of the theme -->
<!-- verified-by: pr test/component/settings/settingsDialog.test.tsx::Cancel restores the palette before preview -->
<!-- verified-by: pr test/component/platform/confirmationAppearance.test.ts::old or unknown settings use Peach and valid palettes survive hydration -->
<!-- verified-by: pr test/component/platform/confirmationAppearance.test.ts::palette names follow color order without changing stored identifiers -->

Security confirmation windows follow the same theme and color scheme, including
settings previews and Cancel.

<!-- verified-by: pr test/component/platform/confirmationAppearance.test.ts::confirmations apply the initial snapshot and follow preview and rollback -->

Transfer states keep the same meaning across color schemes: orange for active transfers,
yellow for paused, green for completed, red for failed and grey for cancelling, queued
or stopped. Connection indicators and the status bar use the same colors.
Connection dots and progress bars have flat fills without outlines.

<!-- verified-by: pr test/visual/transfer-status-colors.spec.ts::transfer status colors stay readable across palettes -->
<!-- verified-by: pr test/visual/transfer-status-colors.spec.ts::connection indicators and auxiliary progress share semantic colors across palettes -->

## Selecting files

The selection rectangle follows the pointer without animation and stays within
the file list when dragged into the neighbouring pane, including when system
animations are disabled.

<!-- verified-by: manual Selection rectangle with system animations disabled -->

When the rectangle runs past the edge of the list, it has no border on that
side, so it reads as carrying on beyond the visible rows rather than ending at
the edge.

<!-- verified-by: manual Selection rectangle past the edge of the list -->

When a folder's list is refreshed, with F5 or because a transfer finished
there, the files still in it stay selected, and the arrow keys and Shift carry
on from the same file. Files you select while the list is still loading are the
ones that stay selected.

<!-- verified-by: pr test/component/file-browser/paneRefresh.test.tsx::a transfer refresh leaves a pane the user browsed away from, and keeps the selection -->
<!-- verified-by: pr test/component/file-browser/paneRefresh.test.tsx::a selection made while the folder is listed again is the one kept -->
<!-- verified-by: pr test/component/file-browser/filePane.test.tsx::the folder listed again keeps the keyboard cursor; another folder starts from the top -->

## Pausing, stopping and resuming transfers

**Pause** keeps the partial data for a later attempt. A paused FTP, FTPS or SFTP
upload resumes when the source and the retained server data pass verification;
otherwise it starts again. WebDAV uploads, including folder uploads, do not
offer Pause because they cannot continue a partly uploaded file.

<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::retryTransfer resumes paused uploads and downloads, but restarts stopped ones -->
<!-- verified-by: pr src-tauri/src/application/upload_resume_tests.rs::staged_prefix_of_an_unchanged_source_resumes_at_its_length -->
<!-- verified-by: pr src-tauri/src/application/upload_resume_tests.rs::a_source_edited_while_paused_restarts_and_drops_its_staging -->
<!-- verified-by: pr src-tauri/src/application/upload_resume_tests.rs::staging_that_is_not_a_prefix_restarts_even_when_the_pin_matches -->
<!-- verified-by: pr test/unit/transfers/transferStore.test.ts::a folder walk pauses only where the file it cuts short can carry on -->
<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::pauseAllTransfers only pauses uploads that can prove a resume, but stopAllTransfers reaches everything active -->
<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::an upload asks to resume only after a pause, never after a stop -->

Resuming a paused transfer does not ask again whether to replace the file
there: it keeps the answer given when the transfer started.

<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::resuming a paused transfer reuses its overwrite answer instead of asking again -->

**Stop** cancels the transfer. Retrying a stopped upload starts it over.

<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::an upload asks to resume only after a pause, never after a stop -->

When the connection to a server is lost, the transfers it cut off can be retried once the
pane is connected again to the same server with the same account. Until then their Retry button
is unavailable.

<!-- verified-by: pr test/component/file-browser/transferConnectionLoss.test.tsx::Retry of a transfer on a lost connection waits until the pane connects again -->
<!-- verified-by: pr test/unit/transfers/transferStore.test.ts::a new connection to the same account takes over the finished rows a closed one left -->

Stopping an upload never deletes a file that was already on the server under
the same name. The old file stays in place until the new one has fully
arrived.

<!-- verified-by: pr src-tauri/src/application/transfer_service_tests.rs::queued_and_active_upload_cancellation_preserve_old_target_and_cleanup_only_staging -->
<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::stopping queued and active uploads never requests deletion of the destination -->

If another program saves over a file while it uploads, the upload ends with an
error saying the file changed, and the file already on the server stays as it
was; upload it again to send the new version.

<!-- verified-by: pr src-tauri/src/application/transfer_service_tests.rs::a_source_saved_over_while_uploading_is_not_put_in_place_and_says_so -->

Stopping a folder upload keeps the files that already reached the server.
Cleanup targets only its own temporary upload file; a server that refuses
cleanup or cannot be reached can leave that temporary file behind.

<!-- verified-by: pr src-tauri/src/protocol/ftp_tests.rs::a_stopped_folder_upload_settles_at_once_and_keeps_what_landed -->
<!-- verified-by: pr src-tauri/src/protocol/ftp_tests.rs::staging_the_server_will_not_delete_does_not_turn_a_stop_into_a_failure -->
<!-- verified-by: pr src-tauri/src/application/recursive_transfer/tests.rs::stopping_a_paused_upload_keeps_what_landed_and_removes_only_its_own_staging -->

## Interrupted downloads

An interrupted download resumes only when the recorded server, account, path,
size and version still match. A changed or unavailable size or version starts
a new download. This compares the server's metadata, not the complete file
contents: a same-size change with the same reported version can go unnoticed.
See [resume limits](protocol-support.md#limitations).

<!-- verified-by: pr src-tauri/src/protocol/transfer_file.rs::resume_requires_the_same_endpoint_path_size_and_version -->
<!-- verified-by: pr src-tauri/src/protocol/transfer_file.rs::an_unknown_size_or_changed_source_starts_over_and_is_never_treated_as_zero -->

If a download does not finish, a file you already had under that name is kept
unchanged.

<!-- verified-by: pr src-tauri/src/protocol/transfer_file.rs::a_short_download_or_a_refused_commit_keeps_the_old_file -->

A download that fails before receiving anything, such as one of a file deleted
on the server, leaves nothing beside the destination.

<!-- verified-by: pr src-tauri/src/protocol/transfer_file.rs::a_download_that_gets_nothing_leaves_nothing_behind -->

## Downloaded files

On NTFS, FTPeach writes a Windows origin mark to downloaded files. It identifies
local-network servers as intranet and other servers as internet. The mark
records the server address without your user name or password and stays with
the file when it is renamed. Writing it is best effort; filesystems without
alternate data streams cannot keep it. See [download security limits](security.md#rust-and-remote-servers).

<!-- verified-by: pr src-tauri/src/local_fs/provenance.rs::a_host_that_cannot_be_reached_from_outside_is_the_intranet -->
<!-- verified-by: pr src-tauri/src/local_fs/provenance.rs::anything_else_is_the_internet -->
<!-- verified-by: pr src-tauri/src/local_fs/provenance.rs::the_mark_carries_the_address_but_never_an_account -->
<!-- verified-by: pr src-tauri/src/local_fs/provenance.rs::the_mark_lands_beside_the_file_and_survives_being_renamed -->

## Copying files and folders

Creating a local file or folder requires its parent to still exist. If that
parent was moved or deleted outside FTPeach, the operation fails without
recreating it.

<!-- verified-by: pr src-tauri/src/local_fs/local_create.rs::a_missing_parent_is_not_recreated_by_new_entries -->

**Delete** moves local files to the Recycle Bin. A network share or a
removable drive has none, so there FTPeach asks again before deleting for
good, and nothing is deleted if you cancel.

<!-- verified-by: pr test/unit/file-browser/paneFileOperations.test.ts::what has no Recycle Bin is offered for a permanent delete, the rest goes to the bin -->

Local file copies appear in Transfers while running and retain their final result.
A failed copy can be retried from its row.

<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::local copies appear in Transfers while running and keep their final result -->

With overwrite handling set to Ask, merging into an existing folder asks separately
for permission to replace matching files inside it. Approving other files in the
same selection does not approve the folder's contents.

<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::file batch consent does not authorize replacing files inside a sibling folder -->

A file cannot replace a folder, or a folder a file. The message identifies the
skipped names; other selected files can still be copied.

<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::batch rejects file-folder mismatches and still copies the other names -->

## Renaming and moving

When renaming or moving finds another file with the same name, FTPeach asks
before replacing it. FTP cannot make the check and rename atomic: a file
another client creates between them can still be replaced. Server-specific
limits are listed in the [file operation guarantees](transfer-safety.md#guarantee-matrix).

<!-- verified-by: pr test/unit/file-browser/paneFileOperations.test.ts::rename replaces a target only on an explicit decision -->
<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::Move to replaces a target only after explicit approval -->
<!-- verified-by: pr src-tauri/src/protocol/ftp_tests.rs::no_replace_rename_refuses_a_taken_target_and_moves_onto_a_free_one -->

When a cut selection includes files you skip, it stays available to paste after
the other files move.

<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::a cut with skipped conflicts stays on the clipboard after the other files move -->

Files can be moved only on your computer or within one server connection.
Between your computer and a server, or between two servers, FTPeach refuses the
move and changes nothing. Copy the files instead.

<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::a move between different endpoints touches nothing, for files and folders -->

## Editing server files in another program

**Open** in a server file's menu opens it with its usual program without asking
you to choose an application.

<!-- verified-by: pr test/component/file-browser/paneActions.test.ts::Open on a remote file opens it with the default program, without asking -->

Opening a server file again while its copy is open, from any tab connected to the
same server and in any program, opens that same copy instead of downloading a
second one, so two copies never overwrite each other's changes. Once the
connection that opened it closes, the next open downloads the file again.

<!-- verified-by: pr src-tauri/src/local_fs/open_with.rs::a_file_opened_again_reuses_its_watched_copy_until_the_watch_stops -->
<!-- verified-by: pr src-tauri/src/commands/open_with.rs::a_launched_copy_can_be_launched_again_from_its_recorded_path -->

When you open a file from a server in another program and change it, your
changes are kept if you quit FTPeach or it closes unexpectedly. At the next
start, FTPeach offers them back until you delete them. Copies you did not
change are removed.

<!-- verified-by: pr src-tauri/src/local_fs/edit_recovery.rs::edited_copies_are_kept_and_untouched_ones_removed -->
<!-- verified-by: pr src-tauri/src/local_fs/edit_recovery.rs::a_crashed_session_is_collected_at_the_next_start -->
<!-- verified-by: pr test/component/open-with/openWithRecovery.test.tsx::recovered edits are offered at start and stay unless deleted -->

## The portable copy

FTPeach from the portable zip keeps its settings, bookmarks and saved passwords
in the `data` folder beside the program. What makes a copy portable is the
`FTPeach.portable` file in its folder, so unpack the whole zip before starting
it.

<!-- verified-by: pr src-tauri/src/local_fs/portable.rs::only_the_marker_makes_a_folder_portable -->

Until you set a master password, Settings says that saved passwords can be read
only on this computer. With a master password they travel with the folder.

<!-- verified-by: pr test/component/settings/settingsDialog.test.tsx::a portable copy says where passwords stay until a master password is set -->

A key or certificate file chosen from inside the program's folder is found
again after the folder is moved or its drive gets another letter. A file kept
anywhere else has to be at the same path on every computer.

<!-- verified-by: pr src-tauri/src/local_fs/portable.rs::a_file_in_the_folder_is_found_again_after_the_folder_moves -->

An update replaces the program and leaves the `data` folder as it is.

<!-- verified-by: pr src-tauri/src/runtime/update_staging_tests.rs::a_portable_update_replaces_the_program_and_leaves_the_data -->

An update that does not carry FTPeach's release signature, is not newer than
your version, or would write outside the program's folder is refused, and
nothing changes.

<!-- verified-by: pr src-tauri/src/runtime/update_staging_tests.rs::a_portable_update_is_held_to_the_release_signature -->
<!-- verified-by: pr src-tauri/src/runtime/update_staging_tests.rs::a_portable_update_that_fails_its_checks_changes_nothing -->

## Unlocking with Windows Hello

Windows Hello unlock is enabled separately on each computer. When the vault
is moved or carried to another computer, it opens there with the master
password, and Windows Hello can be switched on there as well. Switching it off
on one computer leaves it on for the others.

<!-- verified-by: pr src-tauri/src/security/vault_tests.rs::windows_hello_is_switched_on_and_off_per_computer -->

If Windows loses the key, as after a reset of the computer's security chip, the
switch shows off and can be turned on again.

<!-- verified-by: pr src-tauri/src/security/vault_tests.rs::hello_stands_in_for_the_password_and_a_lost_key_does_not_jam_the_switch -->

## Connecting safely

By default, FTPeach does not connect to an SSH server it has not seen before
until you confirm the server's key. A key that has changed since your last
connection is refused.

<!-- verified-by: pr src-tauri/src/protocol/sftp_tests.rs::local_server_pins_reuses_and_rejects_changed_host_key -->

Once you trust the key, FTPeach connects again with the bookmark's saved
password.

<!-- verified-by: pr test/unit/file-browser/paneSessionLifecycle.test.ts::the connect retried after trusting a key keeps the bookmark and its saved password -->

With an `http://` WebDAV address, your password is not sent over plain HTTP
unless you allow unencrypted sign-in for that connection.

<!-- verified-by: pr src-tauri/src/protocol/webdav_tests.rs::an_unencrypted_server_never_sees_the_password -->
<!-- verified-by: pr src-tauri/src/protocol/webdav_tests.rs::cleartext_login_is_refused_until_the_user_allows_it -->
