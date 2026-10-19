# Passwords and bookmarks

## Moving bookmarks and passwords to another computer

File > Export Settings, and Export in the Site Manager, can take the saved
passwords and SSH key passphrases of your bookmarks along. Tick "Include saved
passwords" and choose a password for the file, at least 12 characters, typed
twice. Only the passwords are encrypted with it: addresses, user names and the
other settings in the file stay readable, and a forgotten file password cannot
be recovered. The proxy password is never exported.

<!-- verified-by: pr test/component/settings/settingsTransfer.test.tsx::an export with the saved passwords needs a long password typed twice -->
<!-- verified-by: pr src-tauri/src/security/export_secrets.rs::sealed_secrets_open_with_the_password_only -->
<!-- verified-by: pr src-tauri/src/commands/app_settings_transfer_tests.rs::export_strips_plaintext_encrypted_and_legacy_secret_fields -->

Export then asks for confirmation in a separate window. With a master password
set, it asks for that password even while the vault is open; where Windows
Hello is on, Hello asks first, and the password field follows if you cancel
it. A password that is not accepted is said there, and you can try again.
Bookmarks whose passwords this computer cannot open are named, and the export
goes on without their passwords only when you choose that.

<!-- verified-by: pr src-tauri/src/security/sensitive_tests.rs::an_export_names_whether_it_carries_the_saved_passwords -->
<!-- verified-by: pr test/component/platform/securityConfirmation.test.tsx::with Windows Hello on, Hello is asked alone and the password is the fallback -->
<!-- verified-by: pr test/component/platform/securityConfirmation.test.tsx::failed reauthentication clears the password and allows a corrected retry -->
<!-- verified-by: pr test/component/settings/settingsTransfer.test.tsx::bookmarks whose passwords cannot be opened are named, and left out only when asked -->

Importing such a file asks for its password. A wrong one is asked for again;
"Import without passwords" brings in the bookmarks alone. Passwords move
between system protection and a master password in either direction.

<!-- verified-by: pr test/component/settings/settingsTransfer.test.tsx::a file with passwords asks for its password and keeps asking until it opens them -->
<!-- verified-by: pr test/component/settings/settingsTransfer.test.tsx::a file with passwords can be imported without them, or let go -->
<!-- verified-by: pr src-tauri/src/store/sites/transfer_tests.rs::passwords_carry_between_every_kind_of_protection -->

A password goes only to a bookmark for exactly the server, account and
security settings it was saved for. If the file was edited to send a bookmark
elsewhere, its password stays behind and the import names the bookmark.

<!-- verified-by: pr src-tauri/src/store/sites/transfer_tests.rs::a_bookmark_sent_elsewhere_than_its_secret_leaves_the_secret_behind -->

A bookmark you already have gets the file's password only if it has none
saved; a saved password is never replaced. So importing the file again with
its password fills in what an import without passwords left out. A bookmark
saved here more than once for the same server gets no password, and is named.

<!-- verified-by: pr src-tauri/src/store/sites/transfer_tests.rs::a_second_import_fills_what_the_first_left_out_and_overwrites_nothing -->
<!-- verified-by: pr src-tauri/src/store/sites/transfer_tests.rs::a_duplicate_gets_its_secret_only_from_one_exact_recipient -->

An import that cannot be finished undoes its bookmarks and their passwords. If
even that fails, the message says what was left behind.

<!-- verified-by: pr src-tauri/src/store/sites/transfer_tests.rs::a_bookmark_file_that_cannot_be_written_takes_the_vault_secrets_back -->
<!-- verified-by: pr src-tauri/src/commands/app_settings_transfer_tests.rs::settings_that_cannot_be_saved_undo_the_bookmarks_and_their_passwords -->
<!-- verified-by: pr src-tauri/src/store/sites/transfer_tests.rs::an_undone_import_names_what_it_could_not_undo_and_restores_the_rest -->

A file exported without passwords imports as before. FTPeach 0.4.0 and older
refuse a file with passwords, as they refuse any file with fields they do not
know.

<!-- verified-by: pr src-tauri/src/commands/app_settings_transfer_tests.rs::a_file_with_repeated_ids_or_a_future_format_is_refused -->
<!-- verified-by: pr src-tauri/src/commands/app_settings_transfer_tests.rs::an_empty_or_foreign_file_is_named_as_not_a_settings_file -->

## Unlocking with Windows Hello

Windows Hello unlock is enabled separately on each computer. When the vault
is moved or carried to another computer, it opens there with the master
password, and Windows Hello can be switched on there as well. Switching it off
on one computer leaves it on for the others.

<!-- verified-by: pr src-tauri/src/security/vault_tests.rs::windows_hello_is_switched_on_and_off_per_computer -->

If Windows loses the key, as after a reset of the computer's security chip, the
switch shows off and can be turned on again.

<!-- verified-by: pr src-tauri/src/security/vault_tests.rs::hello_stands_in_for_the_password_and_a_lost_key_does_not_jam_the_switch -->
