# Editing remote files

Use this workflow to change a text file or configuration on a server with a
program installed on your computer. FTPeach opens a downloaded working copy;
saving in the editor and sending that revision to the server are separate steps.

<!-- verified-by: pr test/component/open-with/openWithDialog.test.tsx::download ignores other jobs, clamps progress and registers a completed editable copy -->
<!-- verified-by: pr test/component/open-with/openWithRecovery.test.tsx::only an uploaded revision is marked synced, and a failed upload asks again -->

## Open, edit and upload a change

Before editing an important file, download a backup to a separate local folder.
Check that you have permission to replace the server copy.

1. Connect to the server and locate the file.
2. Right-click it and choose **Open** to use its usual program, or **Open with**
   to choose another program.
3. Make the change and save it in the editor.
4. Return to FTPeach. When it asks whether to upload the changed file, choose
   **Upload** to send that revision to the server. **Later** leaves that upload
   for another time; do not treat a local save as a completed server update.
5. Check the upload result and, where appropriate, check the file in the system
   that uses it, such as the website or application you are updating.

<!-- verified-by: pr test/component/file-browser/paneActions.test.ts::Open on a remote file opens it with the default program, without asking -->
<!-- verified-by: pr test/component/file-browser/paneActions.test.ts::SFTP permissions and open-with retain the entry and its original session -->
<!-- verified-by: pr test/component/open-with/openWithRecovery.test.tsx::changes to several copies are all asked about, one at a time -->
<!-- verified-by: pr test/component/open-with/openWithRecovery.test.tsx::only an uploaded revision is marked synced, and a failed upload asks again -->

If you save again while an upload is running, FTPeach asks about the newer save
after that upload finishes. Keep track of the last revision you approved.

<!-- verified-by: pr test/component/open-with/openWithRecovery.test.tsx::a save made while an upload runs is asked about after it, not during -->

## Recover unfinished edits

If FTPeach offers recovered edits at startup, inspect them before deleting them.
Keep a separate copy of work you still need, reconnect to the intended server
and check its current file before replacing it. Recovery preserves your local
work; it does not mean that those changes already reached the server.

<!-- verified-by: pr test/component/open-with/openWithRecovery.test.tsx::recovered edits are offered at start and stay unless deleted -->

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
