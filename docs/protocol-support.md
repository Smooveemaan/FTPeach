# Protocol support

| Capability | FTP | FTPS | SFTP | WebDAV |
| --- | --- | --- | --- | --- |
| Encryption | No | Explicit TLS | SSH | HTTPS with `https://` |
| Server verification | No | PKI certificate | TOFU host key | PKI certificate |
| List/create/mkdir/rename/delete | Yes | Yes | Yes | Yes |
| Upload/download | Yes | Yes | Yes | Yes |
| Resume upload | Yes | Yes | Yes | No |
| Resume download | Yes | Yes | Yes | Yes |
| `chmod` | No | No | Yes | No |
| Server-to-server relay | Yes | Yes | Yes | Yes |
| SOCKS4/4a, SOCKS5, HTTP CONNECT | Yes | Yes | Yes | Yes |
| Active data mode | Yes | Yes | Not applicable | Not applicable |

FTPS means explicit TLS (`AUTH TLS`), not implicit FTPS. TLS certificate verification is enabled; `allowInvalidCert` should be used only for deliberately trusted self-signed or legacy servers.

## Resume and integrity

Downloads are written to a sibling `*.ftpeach-part` file. FTP/FTPS and SFTP resume from the partial file size; WebDAV sends a Range request and validates `Content-Range`. If a server ignores Range, the download safely restarts. The partial file replaces the destination only after its size is verified.

FTP/FTPS and SFTP uploads resume from the remote file size. An invalid offset produces an integrity error. WebDAV upload resume is not supported.

## Limitations

- WebDAV uploads use a buffered PUT and are limited to 512 MiB before the file is read;
- FTP transmits credentials and data in plain text;
- FTP active mode is incompatible with proxies and usually requires firewall/NAT configuration;
- the first SFTP fingerprint should be independently verified with the administrator;
- server capabilities may further restrict methods and permissions.

See also [`networking.md`](networking.md).

## Compatibility verification

The scheduled **Protocol compatibility** GitHub Actions workflow runs every
Wednesday and can also be started manually with `workflow_dispatch`. It starts
disposable containerized FTP/FTPS, SFTP, and WebDAV servers and runs the ignored
`docker_integration` suite without permanent external credentials.

Coverage includes protocol round trips, cancellation/resume behavior, SFTP
first-use host-key pinning and mismatch rejection, custom certificate
authorities, invalid certificates, and endpoints restricted to TLS 1.2 or TLS
1.3. A scheduled failure opens or updates a repository issue; the workflow is
informational for ordinary pull requests and does not make a public server a
required dependency of the main CI pipeline.

Maintainers can reproduce it on a Docker host from `src-tauri`:

```sh
docker compose -f tests/docker/docker-compose.yml up --detach
cargo test --locked --features test-utils --test docker_integration -- --ignored
docker compose -f tests/docker/docker-compose.yml down --volumes
```
