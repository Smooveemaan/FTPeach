# Portable version

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
