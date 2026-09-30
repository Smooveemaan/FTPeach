# User guide

What FTPeach does in the situations where it matters most: a transfer that
stops halfway, a file that already exists, a server you have not seen before.
Each statement here is backed by an automated check, so it describes how the
current version actually behaves.

For installing FTPeach and the list of supported protocols, see the
[README](../README.md). For what changed between versions, see the
[changelog](../CHANGELOG.md).

## Selecting files

The selection rectangle follows the pointer without animation and stays within
the file list when dragged into the neighbouring pane, including when system
animations are disabled.

<!-- verified-by: manual Selection rectangle with system animations disabled -->

When the rectangle runs past the edge of the list, it has no border on that
side, so it reads as carrying on beyond the visible rows rather than ending at
the edge.

<!-- verified-by: manual Selection rectangle past the edge of the list -->

## Pausing, stopping and resuming transfers

**Pause** keeps what has been transferred so far. Resuming a paused upload over
FTP or SFTP continues where it stopped. Over WebDAV, a resumed upload starts
again from the beginning, because WebDAV cannot add to a partly uploaded file.

<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::retryTransfer resumes paused uploads and downloads, but restarts stopped ones -->
<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::an upload asks to resume only after a pause, never after a stop -->

Resuming a paused transfer does not ask again whether to replace the file
there: it keeps the answer given when the transfer started.

<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::resuming a paused transfer reuses its overwrite answer instead of asking again -->

**Stop** cancels the transfer. Retrying a stopped upload starts it over.

<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::an upload asks to resume only after a pause, never after a stop -->

Stopping an upload never deletes a file that was already on the server under
the same name. The old file stays in place until the new one has fully
arrived.

<!-- verified-by: pr src-tauri/src/application/transfer_service_tests.rs::queued_and_active_upload_cancellation_preserve_old_target_and_cleanup_only_staging -->
<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::stopping queued and active uploads never requests deletion of the destination -->

Stopping a folder upload keeps the files that already reached the server; only
the file that was still being sent is removed.

<!-- verified-by: pr src-tauri/src/protocol/ftp_tests.rs::a_stopped_folder_upload_settles_at_once_and_keeps_what_landed -->
<!-- verified-by: pr src-tauri/src/application/recursive_transfer/tests.rs::stopping_a_paused_upload_keeps_what_landed_and_removes_only_its_own_staging -->

## Interrupted downloads

An interrupted download continues where it stopped only if the file on the
server is still the same one: the same server, path, size and version. If any
of these changed, the download starts over, so a file is never put together
from two different versions.

<!-- verified-by: pr src-tauri/src/protocol/transfer_file.rs::resume_requires_the_same_endpoint_path_size_and_version -->
<!-- verified-by: pr src-tauri/src/protocol/transfer_file.rs::an_unknown_size_or_changed_source_starts_over_and_is_never_treated_as_zero -->

If a download does not finish, a file you already had under that name is kept
unchanged.

<!-- verified-by: pr src-tauri/src/protocol/transfer_file.rs::a_short_download_or_a_refused_commit_keeps_the_old_file -->

## Downloaded files

Downloaded files are marked as coming from the internet, the same way a browser
marks its downloads, so Windows and Office open them with the usual care. The
mark records the server address but never your user name or password, and it
stays with the file when the file is renamed.

<!-- verified-by: pr src-tauri/src/local_fs/provenance.rs::the_mark_carries_the_address_but_never_an_account -->
<!-- verified-by: pr src-tauri/src/local_fs/provenance.rs::the_mark_lands_beside_the_file_and_survives_being_renamed -->

## Renaming and moving

Renaming or moving a file never replaces another file with the same name,
unless you choose to replace it.

<!-- verified-by: pr test/unit/file-browser/paneFileOperations.test.ts::rename and move replace a target only on an explicit decision -->

Files can be moved only on your computer or within one server connection.
Between your computer and a server, or between two servers, FTPeach refuses the
move and changes nothing. Copy the files instead.

<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::a move between different endpoints touches nothing, for files and folders -->

## Editing server files in another program

**Open** in a server file's menu opens it with its usual program without asking
you to choose an application.

<!-- verified-by: pr test/component/file-browser/paneActions.test.ts::Open on a remote file opens it with the default program, without asking -->

When you open a file from a server in another program and change it, your
changes are kept if you quit FTPeach or it closes unexpectedly. At the next
start, FTPeach offers them back until you delete them. Copies you did not
change are removed.

<!-- verified-by: pr src-tauri/src/local_fs/edit_recovery.rs::edited_copies_are_kept_and_untouched_ones_removed -->
<!-- verified-by: pr src-tauri/src/local_fs/edit_recovery.rs::a_crashed_session_is_collected_at_the_next_start -->
<!-- verified-by: pr test/component/open-with/openWithRecovery.test.tsx::recovered edits are offered at start and stay unless deleted -->

## Connecting safely

By default, FTPeach does not connect to an SSH server it has not seen before
until you confirm the server's key. A key that has changed since your last
connection is refused.

<!-- verified-by: pr src-tauri/src/protocol/sftp_tests.rs::local_server_pins_reuses_and_rejects_changed_host_key -->

Once you trust the key, FTPeach connects again with the bookmark's saved
password.

<!-- verified-by: pr test/unit/file-browser/paneSessionLifecycle.test.ts::the connect retried after trusting a key keeps the bookmark and its saved password -->

With an `http://` WebDAV address, your password is not sent until you allow
unencrypted sign-in for that connection.

<!-- verified-by: pr src-tauri/src/protocol/webdav_tests.rs::an_unencrypted_server_never_sees_the_password -->
<!-- verified-by: pr src-tauri/src/protocol/webdav_tests.rs::cleartext_login_is_refused_until_the_user_allows_it -->
