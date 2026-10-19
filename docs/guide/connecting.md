# Safe connections

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
