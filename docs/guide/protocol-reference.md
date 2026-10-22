# Protocol reference

Use this page to check compatibility before choosing a server or investigating
a transfer limitation. For connection steps, see [FTP](ftp.md), [FTPS](ftps.md),
[SFTP](sftp.md) or [WebDAV](webdav.md).

## Capabilities

| Capability | FTP | FTPS | SFTP | WebDAV |
| --- | --- | --- | --- | --- |
| Transport protection | None | Explicit TLS | SSH | HTTPS when using `https://` |
| Server identity | None | Certificate | Pinned host key | Certificate with HTTPS |
| Browse, create folders, rename and delete | Yes | Yes | Yes | Yes |
| Upload and download | Yes | Yes | Yes | Yes |
| Resume a download | Conditional | Conditional | Conditional | Conditional |
| Resume an upload | Conditional | Conditional | Conditional | No |
| Copy between connections | Yes | Yes | Yes | Yes |
| Move within one connection | Yes | Yes | Yes | Yes |

<!-- verified-by: pr src-tauri/src/protocol/ftp_tests.rs::local_server_supports_connect_list_disconnect_and_reconnect -->
<!-- verified-by: pr src-tauri/src/protocol/ftp_tests.rs::local_ftps_server_rejects_bad_certificate_unless_explicitly_allowed -->
<!-- verified-by: pr src-tauri/src/protocol/sftp_tests.rs::local_server_pins_reuses_and_rejects_changed_host_key -->
<!-- verified-by: pr src-tauri/src/protocol/webdav_tests.rs::local_server_round_trips_file_operations_and_resumed_download -->
<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::folder upload, download and relay submit endpoint intent without per-file IPC -->

“Conditional” means the saved partial and the source must pass the checks below.
Server permissions, storage quotas and supported operations can restrict what
an account can do. Copying between connections relays the data through your
computer. Moving between different connections, or between a server and your
computer, is refused; copy instead.

<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::a move between different endpoints touches nothing, for files and folders -->

## Authentication and transport

FTP and explicit FTPS use a username and password. FTPS starts TLS after the
FTP greeting; implicit FTPS, which starts TLS immediately, is not supported.
FTP itself sends credentials and data without encryption.

<!-- verified-by: pr src-tauri/src/protocol/ftp_tests.rs::local_server_supports_connect_list_disconnect_and_reconnect -->
<!-- verified-by: pr src-tauri/src/protocol/ftp_tests.rs::implicit_ftps_is_rejected_as_a_tls_negotiation_error -->

FTPS supports TLS 1.2 and TLS 1.3. Keep certificate verification enabled.
For an organisation's own certificate authority, select its CA file rather than
turning verification off. See [FTPS certificates](ftps.md).

<!-- verified-by: pr src-tauri/src/protocol/ftp_tests.rs::explicit_ftps_connects_with_tls12_and_tls13 -->
<!-- verified-by: pr src-tauri/src/protocol/ftp_tests.rs::local_ftps_server_accepts_a_matching_custom_ca_and_rejects_a_mismatched_one -->

SFTP supports password and SSH private-key login. The OpenSSH key loader is
tested with Ed25519, RSA and ECDSA P-256 keys, with and without a passphrase.
These are key-file checks, not a promise that every server accepts each key.
See [SFTP keys and fingerprints](sftp.md).

<!-- verified-by: pr src-tauri/src/protocol/sftp_tests.rs::openssh_private_keys_load_with_and_without_a_passphrase -->
<!-- verified-by: pr src-tauri/src/protocol/sftp_tests.rs::local_server_pins_reuses_and_rejects_changed_host_key -->

If password authentication is refused, SFTP can fall back to
keyboard-interactive authentication, answering hidden prompts with the saved
password. This is not an interactive one-time-code prompt.

<!-- verified-by: pr src-tauri/src/protocol/sftp_tests.rs::password_login_falls_back_to_keyboard_interactive -->

WebDAV uses Basic authentication, not Digest. Use an HTTPS endpoint.
A server that accepts only Digest refuses sign-in. The URL must have no embedded
credentials, query string or fragment. Plain HTTP requires an explicit opt-in
before credentials are sent; a same-host, same-path redirect can upgrade it to
HTTPS. See [WebDAV connections](webdav.md).

<!-- verified-by: pr src-tauri/src/protocol/webdav_tests.rs::basic_login_succeeds_but_a_digest_only_server_is_refused -->
<!-- verified-by: pr src-tauri/src/protocol/webdav_tests.rs::a_webdav_address_may_not_carry_credentials_or_a_query -->
<!-- verified-by: pr src-tauri/src/protocol/webdav_tests.rs::only_the_same_host_and_path_are_upgraded_to_https -->
<!-- verified-by: pr src-tauri/src/protocol/webdav_tests.rs::an_unencrypted_server_never_sees_the_password -->

## SSH algorithms

These are the SSH library's default offers, in preference order. The server and
client must agree on algorithms; this table does not mean every combination has
been tested against every server. Host-key algorithms identify the server and
are separate from the format of your private-key file.

| SSH category | Default offer, in order |
| --- | --- |
| Key exchange | `mlkem768x25519-sha256`, `curve25519-sha256`, `curve25519-sha256@libssh.org`, `diffie-hellman-group-exchange-sha256`, `diffie-hellman-group18-sha512`, `diffie-hellman-group17-sha512`, `diffie-hellman-group16-sha512`, `diffie-hellman-group15-sha512`, `diffie-hellman-group14-sha256` |
| Host key | `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ecdsa-sha2-nistp384`, `ecdsa-sha2-nistp521`, `rsa-sha2-512`, `rsa-sha2-256`, `ssh-rsa` |
| Cipher | `chacha20-poly1305@openssh.com`, `aes256-gcm@openssh.com`, `aes256-ctr`, `aes192-ctr`, `aes128-ctr` |
| MAC | `hmac-sha2-512-etm@openssh.com`, `hmac-sha2-256-etm@openssh.com`, `hmac-sha2-512`, `hmac-sha2-256` |
| Compression | `none`, `zlib`, `zlib@openssh.com` |

<!-- verified-by: pr src-tauri/src/protocol/sftp_tests.rs::ssh_algorithm_reference_matches_client_defaults -->

SSH negotiation extension markers are omitted. Host-key certificates are not
in the default offer. With the default host-key checking, an unconfirmed key
stops login until you trust its fingerprint; verify it with the administrator.
A changed pinned key stops the connection.

<!-- verified-by: pr src-tauri/src/protocol/sftp_tests.rs::ssh_algorithm_reference_matches_client_defaults -->
<!-- verified-by: pr src-tauri/src/protocol/sftp_tests.rs::local_server_pins_reuses_and_rejects_changed_host_key -->

## Resume and integrity

Downloads are written to a hidden sibling `.ftpeach-<id>.part` file. Resume
requires the same endpoint, remote path, size and recorded version. Changed or
unknown source information starts a fresh download. The partial replaces the
destination only after its size is verified; a short download keeps the previous
destination intact.

<!-- verified-by: pr src-tauri/src/protocol/transfer_file_tests.rs::partial_is_a_sibling_with_stable_suffix -->
<!-- verified-by: pr src-tauri/src/protocol/transfer_file_tests.rs::resume_requires_the_same_endpoint_path_size_and_version -->
<!-- verified-by: pr src-tauri/src/protocol/transfer_file_tests.rs::an_unknown_size_or_changed_source_starts_over_and_is_never_treated_as_zero -->
<!-- verified-by: pr src-tauri/src/protocol/transfer_file_tests.rs::a_short_download_or_a_refused_commit_keeps_the_old_file -->

WebDAV resumes with a Range request and validates the returned range. If the
server ignores Range, the download restarts. A version read in the same second
as the modification is not trusted for resume.

<!-- verified-by: pr src-tauri/src/protocol/webdav_tests.rs::resume_restarts_when_range_is_ignored_and_rejects_416 -->
<!-- verified-by: pr src-tauri/src/protocol/webdav_tests.rs::content_range_must_match_resume_offset_and_total -->
<!-- verified-by: pr src-tauri/src/protocol/webdav_tests.rs::a_version_from_the_second_the_file_changed_is_not_trusted -->

Paused FTP/FTPS and SFTP uploads resume only if the local source identity still
matches and up to 8 KiB of the retained staging tail matches the source.
Changed or unverifiable staging restarts the upload. This is not a full hash of
everything already sent. WebDAV uploads offer no Pause and start over on retry.
See [Transfers](transfers.md) for the controls.

<!-- verified-by: pr src-tauri/src/application/upload_resume_tests.rs::verification_reads_back_a_bounded_tail_however_much_was_staged -->
<!-- verified-by: pr src-tauri/src/application/upload_resume_tests.rs::staging_that_is_not_a_prefix_restarts_even_when_the_pin_matches -->
<!-- verified-by: pr src-tauri/src/application/upload_resume_tests.rs::a_source_edited_while_paused_restarts_and_drops_its_staging -->
<!-- verified-by: pr test/component/transfers/useTransfers.test.tsx::pauseAllTransfers only pauses uploads that can prove a resume, but stopAllTransfers reaches everything active -->

## Limitations

FTP/FTPS and SFTP identify remote versions by size and modification time, with
one-second time resolution. Replacing a file with different content of the
same size within that second can escape this check. If a file is being rewritten,
download it again from the start instead of resuming it.

<!-- verified-by: pr src-tauri/src/protocol/transfer_file_tests.rs::resume_requires_the_same_endpoint_path_size_and_version -->

FTP active mode needs the server to connect back to your computer and is
disabled when using a proxy. SOCKS4/4a cannot address IPv6 destinations;
SOCKS5 and HTTP CONNECT can. See [FTP data connections](ftp.md) and
[networking details](../networking.md) for proxy configuration.

<!-- verified-by: pr src-tauri/src/protocol/ftp_tests.rs::active_mode_stores_lists_and_fetches_over_the_servers_connection -->
<!-- verified-by: pr src-tauri/src/protocol/proxy_tests.rs::socks4_rejects_ipv6_with_an_actionable_error -->
<!-- verified-by: pr src-tauri/src/protocol/proxy_tests.rs::socks5_encodes_ipv6_targets_with_the_native_address_type -->
<!-- verified-by: pr src-tauri/src/protocol/proxy_tests.rs::http_connect_brackets_ipv6_authorities -->

## Compatibility verification

Automated checks cover local protocol servers, authentication, certificate and
host-key rejection, transfers and resume. The SSH algorithm table is checked
against the dependency's defaults so a library update cannot silently leave it
stale. For the broader release checks against server implementations and faulty
links, see [How releases are verified](../release-trust.md#how-releases-are-verified).

<!-- verified-by: pr src-tauri/src/protocol/sftp_tests.rs::ssh_algorithm_reference_matches_client_defaults -->
