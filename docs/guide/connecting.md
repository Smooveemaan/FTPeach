# Connect to a server

A connection gives one pane access to files on a server. Before filling in the
form, get the protocol, address, account details and destination folder from your
provider. A website address alone may not be the file transfer address.

## Choose the connection type

| Protocol | What it means for your connection |
| --- | --- |
| FTP | An unencrypted connection. FTPeach shows a warning; ask your provider whether an encrypted option is available. |
| FTPS | FTP protected by TLS. The server's certificate is checked. |
| SFTP | File transfer over SSH. Check the server's host key; your account may use a password or an SSH key. |
| WebDAV | File access through an HTTP or HTTPS URL. Use the full URL supplied by the provider, including its path. Prefer HTTPS. |

<!-- verified-by: pr test/component/file-browser/connectionBar.test.tsx::plain FTP carries the unencrypted warning, and an encrypted protocol drops it -->
<!-- verified-by: pr src-tauri/src/protocol/ftp_tests.rs::local_ftps_server_rejects_bad_certificate_unless_explicitly_allowed -->
<!-- verified-by: pr src-tauri/src/protocol/sftp_tests.rs::local_server_pins_reuses_and_rejects_changed_host_key -->
<!-- verified-by: pr test/unit/file-browser/paneSessionLifecycle.test.ts::WebDAV accepts an absolute URL with a custom port -->

SFTP and FTPS are different protocols, even if both are described as "secure
FTP" by a provider. Do not switch between them just to make an error disappear.
The [protocol reference](../protocol-support.md) lists compatibility details.

## Enter your connection details

1. Click the source button at the top of a pane and choose **Server**, then
   choose the protocol your server supports.
2. Enter its **Address** and **Port**, then your **Username** and **Password**.
   Use the port supplied by the provider if it differs from the suggested one.
3. Select **Connect**. Once the initial folder listing loads, browse to the
   folder you want to work in.

<!-- verified-by: pr test/component/file-browser/connectionBar.test.tsx::blank addresses disable connecting and saving until filled -->
<!-- verified-by: pr test/component/file-browser/paneSourceSwitcher.test.tsx::the source selector opens a server form and returns to the computer -->
<!-- verified-by: pr test/unit/file-browser/paneSessionLifecycle.test.ts::a typed-in FTPS server is sent as it is, and becomes connected only after its first listing -->

For WebDAV, use an absolute URL such as `https://files.example.com/dav/`,
not just a hostname. The example is a placeholder; use your provider's URL.

<!-- verified-by: pr test/unit/file-browser/paneSessionLifecycle.test.ts::invalid WebDAV addresses stay in the pane without starting a session -->

For SFTP with a key, select **Log in with SSH key**, choose the **Key file** and
enter its **Passphrase** if required. This uses the key instead of the account
password. Keep the private key private; the server administrator normally needs
your public key, not the private file.

<!-- verified-by: pr test/component/file-browser/connectionBar.test.tsx::key authentication clears the password and warns for a selected RSA key -->

## Save a connection you will use again

A bookmark saves you from entering the same details every time. Open **File >
Manage Bookmarks**, choose **New Bookmark**, give it a recognizable **Name**,
fill in the connection details and choose **Save**. Use the bookmark's edit
button when its address or account details change.

<!-- verified-by: pr test/component/sites/siteManager.test.tsx::creates and edits a bookmark through the form -->
<!-- verified-by: pr test/unit/application/menus.test.ts::menu commands bind current tab, pane and theme and both copy refresh callbacks -->

Click a bookmark row, or focus it and press **Enter**, to connect. Search can find
bookmarks by name, host, user or folder. Use names that distinguish production
and test servers before you start copying files.

<!-- verified-by: pr test/component/sites/siteManager.test.tsx::clicking a site row connects; clicking its own buttons does not -->
<!-- verified-by: pr test/component/sites/siteManager.test.tsx::Enter connects a focused site row and toggles a focused folder row -->
<!-- verified-by: pr test/component/sites/siteManager.test.tsx::search filters bookmarks by name, host, user and folder, and connects from results -->

See [Passwords and bookmarks](passwords.md) before moving saved connections to
another computer. If connecting fails, start with the [connection checklist](troubleshooting.md#i-cannot-connect).

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
