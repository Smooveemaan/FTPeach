# SFTP connections

Use SFTP when your provider gives you SSH file access. You can sign in with an
account password or a private SSH key. SFTP is a different connection type from
FTPS: select the one your server actually provides.

<!-- verified-by: pr test/component/file-browser/connectionBar.test.tsx::key authentication clears the password and warns for a selected RSA key -->
<!-- verified-by: pr src-tauri/src/protocol/sftp_tests.rs::local_server_pins_reuses_and_rejects_changed_host_key -->

## Before you connect

Ask your provider or server administrator for:

- The server hostname or IP address and its SSH port.
- Your username and whether the account uses a password or a key.
- The server's expected host-key fingerprint, through a channel you already trust.
- The folder you should work in and whether you may upload or replace files there.

Three different secrets or identities can be involved:

| Item | What it is for |
| --- | --- |
| Account password | Signing in to the server as your username. |
| Your private key and its passphrase | Proving your account identity instead of using the account password. The passphrase unlocks the key file. |
| Server host-key fingerprint | Checking that the server is the one you meant to reach. This is not your account's SSH key. |

> [!WARNING]
> **Keep your private key on your computer.** Give the administrator the matching
> public key when arranging access, not the private file or its passphrase.

<!-- verified-by: pr test/component/file-browser/connectionBar.test.tsx::key authentication clears the password and warns for a selected RSA key -->
<!-- verified-by: pr test/component/platform/securityConfirmation.test.tsx::host-key confirmation shows the actual and pinned fingerprints -->

## Connect with a password

1. Open the source menu at the top of a pane and choose **Server**.
2. Choose **SFTP** in the protocol selector.
3. Enter **Address** and **Username**. The suggested port is **22**; enter a
   different **Port** if your provider specifies one.
4. Leave **Log in with SSH key** off and enter your account **Password**.
5. Select **Connect**, then [verify the server](#verify-the-server) if prompted.

[![SFTP selected in the connection form, with address, port, username and password fields.](../../site/images/guide/connection.png)](../../site/images/guide/connection.png)

Use your provider's details in place of this example address and username.

<!-- verified-by: pr test/component/file-browser/paneSourceSwitcher.test.tsx::the source selector opens a server form and returns to the computer -->
<!-- verified-by: pr test/component/file-browser/connectionBar.test.tsx::switching protocol empties a default port and keeps a custom one -->
<!-- verified-by: pr test/component/file-browser/connectionBar.test.tsx::blank addresses disable connecting and saving until filled -->

## Connect with an SSH key

First arrange for the matching public key to be authorized for your server
account. Selecting a file in FTPeach does not grant that account access.

1. Choose **SFTP** and enter the same address, port and username as above.
2. Turn on **Log in with SSH key**. This replaces the password field with the
   key controls and clears the account password from the form.
3. Select the key-shaped **Key file** button and choose your private key file.
   Do not choose its public `.pub` file.
4. Enter the key's **Passphrase** if it has one; otherwise leave that field empty.
5. Select **Connect**, then check the server fingerprint if prompted.

[![SFTP key authentication enabled, showing the Key file button and Passphrase field.](../../site/images/guide/sftp-key.png)](../../site/images/guide/sftp-key.png)

The key button opens a file picker. The passphrase belongs to that file, not to
your server account or the FTPeach password vault.

<!-- verified-by: pr test/component/file-browser/connectionBar.test.tsx::key authentication clears the password and warns for a selected RSA key -->

### Choosing a key file

FTPeach can read OpenSSH private-key files containing **Ed25519**, **RSA** or
**ECDSA P-256** keys, including passphrase-protected files. OpenSSH is the file format; Ed25519,
RSA and ECDSA are key types. A filename extension alone does not identify either.
An OpenSSH private-key file starts with `-----BEGIN OPENSSH PRIVATE KEY-----`.

<!-- verified-by: pr src-tauri/src/protocol/sftp_tests.rs::openssh_private_keys_load_with_and_without_a_passphrase -->

For a new key, prefer Ed25519 when your administrator supports it. FTPeach
shows a warning when it recognizes a selected RSA private key because of a
known timing-side-channel risk. The warning is not a rejection of the key.

<!-- verified-by: pr test/component/file-browser/connectionBar.test.tsx::key authentication clears the password and warns for a selected RSA key -->

If your supplied key cannot be read, confirm its format and passphrase with
the administrator. Renaming its extension does not convert it. Keep the
original if you export a copy in another format.

## Verify the server

On a first connection, the default settings stop sign-in until you confirm the
server's host key. Compare the offered fingerprint with the one supplied by your
administrator. If it matches, choose **Trust this server**; FTPeach retries the
connection. If you cannot verify it, cancel and ask the administrator first.

<!-- verified-by: pr src-tauri/src/protocol/sftp_tests.rs::local_server_pins_reuses_and_rejects_changed_host_key -->
<!-- verified-by: pr test/unit/file-browser/paneSessionLifecycle.test.ts::a first sighting is trusted without an expected fingerprint, and a declined one stops -->
<!-- verified-by: pr test/unit/file-browser/paneSessionLifecycle.test.ts::the connect retried after trusting a key keeps the bookmark and its saved password -->

A later change to the host key stops the connection too. The confirmation shows
the previously trusted fingerprint and the newly offered one. A server reinstall
can explain a change, but do not assume that is the cause. Verify the new
fingerprint independently before choosing **Trust the new key**.

<!-- verified-by: pr src-tauri/src/protocol/sftp_tests.rs::local_server_pins_reuses_and_rejects_changed_host_key -->
<!-- verified-by: pr test/component/platform/securityConfirmation.test.tsx::host-key confirmation shows the actual and pinned fingerprints -->
<!-- verified-by: pr test/unit/file-browser/paneSessionLifecycle.test.ts::a refused host key is answered by the backend window, then the connect is retried -->

## When SFTP does not connect

Start with the exact message. These checks suggest what to investigate; a
message alone may not identify the cause.

| Message | What to check |
| --- | --- |
| Incorrect username or password | Confirm the username and whether the account expects a password or a key. For key login, ask whether the matching public key is authorized for that account. |
| Couldn't read the key — the file is corrupted or the passphrase is incorrect. | Select the private file again, check its format and use its passphrase rather than the account password. |
| The key or certificate file was not found | The file may have moved or its drive may be unavailable. Select it again from its current location. |
| The server's host key has changed, so FTPeach didn't connect. | Follow the fingerprint checks above before trusting a replacement key. |
| The server and FTPeach have no SSH algorithm in common. | Ask the administrator to check the server's SSH configuration and compatibility. Changing your password does not resolve an algorithm mismatch. |
| Connection refused / Server is not responding | Confirm the SSH port, server availability and any VPN or network access requirements. See the [connection checklist](troubleshooting.md#i-cannot-connect). |

<!-- verified-by: pr test/unit/platform/errorMessages.test.ts::friendlyError localizes every structured command error code -->
<!-- verified-by: pr src-tauri/src/protocol/sftp_tests.rs::openssh_private_keys_load_with_and_without_a_passphrase -->

## Once connected

Open the folder your provider named, then try a small file using
[Your first transfer](getting-started.md). If signing in works but a file
operation is denied, check the folder and account permissions with the
administrator; signing in does not mean you can write to every folder.

For repeat connections, [save a bookmark](connecting.md#save-a-connection-you-will-use-again).
If you carry keys on a removable drive, read about [portable key files](portable.md#the-portable-copy).
For editing files directly from a server pane, see [Editing remote files](editing.md).
