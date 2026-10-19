# Passwords and bookmarks

A bookmark remembers how to reach a server; a saved password lets FTPeach sign
in without asking you to type that server password again. Start with
[saving a connection](connecting.md#save-a-connection-you-will-use-again) if you
have not created a bookmark yet.

<!-- verified-by: pr test/component/sites/siteManager.test.tsx::creates and edits a bookmark through the form -->
<!-- verified-by: pr test/unit/file-browser/paneSessionLifecycle.test.ts::the connect retried after trusting a key keeps the bookmark and its saved password -->

## Know which password is being requested

| Password | What it is for |
| --- | --- |
| Server account password | Signing in to the server with your username. Your provider manages this account. |
| SSH key passphrase | Unlocking the private key you chose for SFTP. It is not the server account password. |
| FTPeach master password | Unlocking the vault of saved secrets when you have set up master-password protection. |
| Export file password | Opening saved passwords included in an exported file. You choose it when exporting. |

<!-- verified-by: pr test/component/file-browser/connectionBar.test.tsx::key authentication clears the password and warns for a selected RSA key -->
<!-- verified-by: pr src-tauri/src/security/vault_tests.rs::setup_lock_unlock_and_password_change_preserve_secrets -->
<!-- verified-by: pr test/component/settings/settingsTransfer.test.tsx::an export with the saved passwords needs a long password typed twice -->

Do not change a server password to solve a vault-unlock prompt, or assume that
your master password is the password for an exported file. Read which operation
is asking before entering a secret.

[![Security settings with Enhanced protection selected and Windows Hello unlock enabled.](../../site/images/guide/security.png)](../../site/images/guide/security.png)

**Edit > Settings > Security** contains password protection and unlock settings.
This example already has a master password; your choices may differ.

## Prepare to use another computer

For another installation, export your settings or bookmarks on the old computer
and import the file on the new one. Decide whether to include saved passwords:
leaving them out means signing in again with your server credentials. If you do
include them, store the export file and its password separately. The steps and
limits are below.

<!-- verified-by: pr test/component/settings/settingsTransfer.test.tsx::a file with passwords can be imported without them, or let go -->

For a folder you can carry between computers, see [Portable version](portable.md).
Windows Hello is configured per computer, as described at the end of this page.

## Moving bookmarks and passwords to another computer

File > Export Settings, and Export in the Site Manager, can take the saved
passwords and SSH key passphrases of your bookmarks along. Tick "Include saved
passwords" and choose a password for the file, at least 12 characters, typed
twice. Only the passwords are encrypted with it: addresses, user names and the
other settings in the file stay readable, and a forgotten file password cannot
be recovered. The proxy password is never exported.

[![Export Settings with Bookmarks and Include saved passwords selected, and empty file-password fields.](../../site/images/guide/export-settings.png)](../../site/images/guide/export-settings.png)

Select **Bookmarks** before **Include saved passwords**, then enter and confirm
the export file's password. This example has no saved secrets to include.

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
