# Transfers and files

Use a copy when you want the file in another location while keeping the source.
First open the destination folder in the other pane, then select the files or
folders you want to send.

## Upload, download or copy

| From → to | Action in the source pane's right-click menu |
| --- | --- |
| Computer → server | Upload to other pane |
| Server → computer | Download to other pane |
| Server → another server | Copy to other pane |

<!-- verified-by: pr test/component/file-browser/paneActions.test.ts::the menus follow the order of the Explorer menu -->
<!-- verified-by: pr test/component/file-browser/paneActions.test.ts::remote-to-remote copies are labelled correctly and unavailable transfers are disabled -->

1. Check the server or computer and the open path in both panes.
2. Select the files or folders in the source pane. Choose the action above, or
   press **F8** with that pane focused using the default shortcuts.
3. If asked about existing files, decide whether those destination copies should
   be replaced. A matching name does not mean that the contents are the same.
4. Follow the job in **Transfers** and check its final result before closing the
   connection or removing the source.

<!-- verified-by: pr test/component/file-browser/paneActions.test.ts::a folder, and a whole selection, can be sent to the other pane from the menu -->
<!-- verified-by: pr test/component/file-browser/filePane.test.tsx::F7/Shift+F7 create a new folder/file and F8 copies the selection to the other pane -->
<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::file batch consent does not authorize replacing files inside a sibling folder -->
<!-- verified-by: pr test/component/transfers/transferQueue.test.tsx::direction arrow is pinned before Route and File, while Status stays sortable -->

For a server-to-server copy, connect both panes and open the source folder on
one and the destination folder on the other. Files and folders can be sent this
way. For a first upload or download, follow [Your first transfer](getting-started.md).

<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::folder upload, download and relay submit endpoint intent without per-file IPC -->

## Choose whether to pause or stop

Use **Pause** when you intend to continue later and that action is available.
Use **Stop** when you want to cancel the job. Resume a paused job to continue;
retry a stopped job only when you intend to start it again. The details below
explain when partial data can be reused.

<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::retryTransfer resumes paused uploads and downloads, but restarts stopped ones -->

If a transfer reports an error, read it before retrying: wrong permissions,
insufficient space or a changed source need attention first. See
[Troubleshooting](troubleshooting.md#my-transfer-did-not-finish).

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
See [resume limits](../protocol-support.md#limitations).

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
alternate data streams cannot keep it. See [download security limits](../security.md#rust-and-remote-servers).

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
limits are listed in the [file operation guarantees](../transfer-safety.md#guarantee-matrix).

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
