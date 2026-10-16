# Protocol support

| Capability | FTP | FTPS | SFTP | WebDAV |
| --- | --- | --- | --- | --- |
| Encryption | No | Explicit TLS | SSH | HTTPS with `https://` |
| Server verification | No | PKI certificate | Pinned host key, confirmed on first use | PKI certificate |
| List/create/mkdir/rename/delete | Yes | Yes | Yes | Yes |
| Upload/download | Yes | Yes | Yes | Yes |
| Resume upload | Yes | Yes | Yes | No |
| Resume download | Yes | Yes | Yes | Yes |
| `chmod` | No | No | Yes | No |
| Server-to-server copy (relay) | Yes | Yes | Yes | Yes |
| Move within one connection | Yes | Yes | Yes | Yes |
| SOCKS4/4a, SOCKS5, HTTP CONNECT | Yes | Yes | Yes | Yes |
| Active data mode | Yes | Yes | Not applicable | Not applicable |

Moving files between the computer and a server, or between two connections, is refused for every protocol; copy them instead.

FTPS means explicit TLS (`AUTH TLS`), not implicit FTPS. TLS certificate verification is enabled; `allowInvalidCert` should be used only for deliberately trusted self-signed or legacy servers.

## Unsupported variants and authentication

- **Implicit FTPS** (TLS before the greeting, usually port 990) is not supported. Such a server is refused at once with a TLS negotiation error that names implicit FTPS, not after a timeout. Use explicit FTPS on the server's regular port.
- **WebDAV Digest authentication** is not supported; WebDAV signs in with Basic authentication, over HTTPS or with `allowCleartextAuth`. A server that accepts only Digest fails sign-in with an authentication error.
- **SSH keyboard-interactive authentication** is supported: hidden prompts are answered with the site password, so servers that disable the `password` method still accept the login. Public-key authentication covers Ed25519, RSA and ECDSA keys, including passphrase-protected ones.

## Resume and integrity

Downloads are written to a hidden sibling `.ftpeach-<id>.part` file. A download resumes only when the remote file still has the size and version (FTP `MDTM`, SFTP modification time, WebDAV strong `ETag` or `Last-Modified`) recorded when the partial was started. FTP/FTPS and SFTP resume from the partial file size; WebDAV sends a Range request with `If-Range` and validates `Content-Range`. A WebDAV version read in the same second the file was last modified is not trusted, since the file could change again within that second without a new version; such a download restarts instead of resuming. If a server ignores Range, the download safely restarts. The partial file replaces the destination only after its size is verified.

Paused FTP/FTPS and SFTP uploads resume from their retained staging file only after
the local source identity still matches and up to 8 KiB of the staging tail matches
the source. Changed, missing or unverifiable data starts a fresh upload; this is not
a full hash of everything already sent. An invalid offset at the protocol layer
produces an integrity error. WebDAV uploads, including folder uploads, offer no
Pause and restart from the beginning when retried.

## Limitations

- WebDAV uploads use a streaming PUT with bounded buffers; upload resume is not supported, and server-side size limits still apply;
- FTP transmits credentials and data in plain text;
- FTP/FTPS and SFTP tell file versions apart only to the second (FTP `MDTM`, SFTP
  modification time) and give no server time to compare with. A file replaced by another of
  the same size within the second a download started is not detected, and resuming that
  download joins old and new content. WebDAV avoids this by comparing `Last-Modified` with
  the reply's `Date`; to be safe on FTP or SFTP, download a file that is being rewritten
  again from the start instead of resuming it;
- FTP active mode is incompatible with proxies and usually requires firewall/NAT configuration;
- the first SFTP fingerprint should be independently verified with the administrator;
- an SSH server's key is pinned per host and port. With `strictHostKeyCheck` on, the
  default, a key that has not been confirmed stops the connection before authentication;
  the fingerprint is shown and, once trusted, pinned. A changed key always stops it.
- server capabilities may further restrict methods and permissions.
- a WebDAV address must be an absolute `http://` or `https://` URL with no userinfo,
  query string or fragment. An `http://` address is probed without credentials and
  upgraded to `https://` when the server redirects there on the same host and path;
  signing in over plain HTTP otherwise needs the connection's `allowCleartextAuth` opt-in.

See also [`networking.md`](networking.md).

## Compatibility verification

Before every release, closed suites check the client against real servers
([How releases are verified](release-trust.md#how-releases-are-verified)): protocol round trips against disposable FTP/FTPS, SFTP and
WebDAV servers in containers, with cancellation and resume, SFTP first-use
host-key pinning and mismatch rejection, custom certificate authorities,
invalid certificates and endpoints restricted to TLS 1.2 or TLS 1.3; and a
broader matrix of server implementations and configurations, IIS, proxies,
relays between different servers and faulty links. Neither needs permanent
external credentials.
