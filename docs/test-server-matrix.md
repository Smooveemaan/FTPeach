# Test server matrix

The server matrix runs the real client against many FTP/FTPS, SFTP and WebDAV
implementations and configurations, through SOCKS and HTTP proxies and over
deliberately faulty links. It shows what unit tests and local fixtures cannot:
how third-party servers actually behave.

It is separate from the compatibility stack in `src-tauri/tests/docker/docker-compose.yml`,
which CI and the release gate depend on. The matrix includes that stack as its
`baseline` profile and never changes it.

- Servers: `src-tauri/tests/docker/matrix/` (compose file, images, configs, seed).
- Catalog of servers, ports and logins: `src-tauri/tests/docker/matrix/servers.json`.
- Ports, credentials and confirmed server behaviour: [the matrix README](../src-tauri/tests/docker/matrix/README.md).
- Tests: `src-tauri/tests/server_matrix/` (target `server_matrix`, feature `test-utils`).

## Running it from scratch

You need Docker (Docker Desktop on Windows), Node 24 and the Rust toolchain. On
Windows the tests build through `scripts/with-libsodium.ps1`, like the rest of
the Rust suite, so prepare libsodium once as the [README](../README.md) describes.

```sh
npm run servers:up -- ftp sftp       # build the images, start, wait for health, print logins
npm run servers:test -- ftp sftp     # every test for those profiles, in one process
npm run servers:ci -- ftp sftp       # the same, one scenario per process, with a report
npm run servers:status
npm run servers:down -- --volumes    # also drops the seeded fixtures
```

The first start builds about a dozen images and seeds the fixtures, including
a 10 000-file folder and a 64 MiB file (`FTPEACH_MATRIX_BIG_MB` changes the
size). Later starts reuse both.

Docker Desktop cannot hold every profile at once comfortably. Start one or
two, test them, and stop them before the next.

## Profiles and selection

| Profile | What it starts |
| --- | --- |
| `ftp` | vsftpd (plain, TLS session reuse, NAT address, implicit FTPS), ProFTPD (TLS 1.2 / 1.3, bad certificates), pyftpdlib (EPSV only, cp1251 names), SFTPGo |
| `sftp` | OpenSSH (keys, keyboard-interactive, legacy, modern, chroot), ProFTPD mod_sftp, Dropbear, SFTPGo |
| `webdav` | Apache (Basic, Digest, HTTPS), nginx (dav_ext; HTTP/2 without ranges; a subpath behind a redirect), rclone, SFTPGo |
| `heavy` | Nextcloud; the first start installs it and takes several minutes |
| `proxy` | Dante SOCKS5 (with and without login), 3proxy SOCKS4a, Squid HTTP CONNECT (with and without login) |
| `chaos` | Toxiproxy in front of one server per protocol |
| `baseline` | the CI compatibility stack |
| `iis` | IIS FTP and IIS WebDAV on the Windows host, not in Docker |

`all` means `ftp sftp webdav proxy baseline`. `heavy`, `chaos` and `iis` run
only when named: they are slow, or they change the machine.

The tests read the selection from `FTPEACH_MATRIX` (profiles, which is what
`servers:test` and `servers:ci` set) or `FTPEACH_MATRIX_TARGETS` (single
servers, such as `vsftpd,dropbear`). No selection is the same as `all`.

A test for a server that is not selected prints `NOT SELECTED [test name]`
and passes; another profile covers it. A selected server that does not answer
fails the test: a broken setup is never reported as a pass. Tests that need two
servers (relays) or a server and a proxy run only when both are selected.

A test that skips itself although its servers are selected prints
`NOT RUN [test name]` with the reason. `servers:ci` fails the run on it unless
the test is one of the exceptions listed in `scripts/test-servers/ci.ts`
(`EXPECTED_NOT_RUN`), each with its reason.

### IIS

`scripts/test-servers/iis.ps1 install` enables the IIS features, creates a
local user, a certificate, fixtures and three sites; `uninstall` reverts
exactly what `install` added. It changes the machine, so run it only on a
disposable runner or after deciding to on a development machine, from an
elevated PowerShell. It works on Windows 11 Home and on Windows Server, where it
uses `Install-WindowsFeature`. Then:

```sh
npm run servers:test -- iis
```

## What the tests cover

| Group | Tests | What they check |
| --- | --- | --- |
| Scenarios S1-S17 | `common::<server>::sNN_*` | connect, listing, mkdir, transfer, awkward names, rename, recursive delete, 10 000 entries, 30-level tree, resume, overwrite, permissions, hidden files, links, full disk, parallel connections, missing paths |
| SFTP scenarios S18-S19 | `sftp_only::<server>::*` | chmod, host key pinning |
| Server specifics | `specific::*` | implicit FTPS and Digest refused clearly, certificates, anonymous and read-only users, cp1251 names, every key type, keyboard-interactive, legacy SSH, HTTP/2, resume after the file changed, active mode |
| Proxies | `specific::proxy_*` | a round trip through each proxy type, wrong proxy passwords, encodings over a proxy, active mode staying passive behind a proxy |
| Relays | `specific::relay_*` | server-to-server copies between different implementations |
| Faulty links | `chaos_links::<target>::cNN_*` | 300 ms / 256 KB/s link, a drop mid-download and its resume, a server that stops answering, a drop during a large listing |

Active-mode FTP needs the container to reach the client back. On Linux the test
connects to the container's bridge address; Docker Desktop routes neither way,
so on Windows and macOS those tests report NOT RUN with the reason. This is the
one listed exception.

## Weekly CI

`.github/workflows/server-matrix.yml` runs every Saturday and on demand
(`workflow_dispatch`). It never blocks a pull request.

- One Ubuntu job per profile group: `ftp`, `sftp`, `webdav`, `baseline`,
  `heavy`, and `proxy-chaos` (proxies, Toxiproxy and cross-profile relays).
- A `windows-iis` job installs IIS on the Windows Server runner with `iis.ps1`.
- Images are built with Buildx from the compose file and cached in the Actions
  cache; Rust builds use `rust-cache`. Each job has its own time limit.
- `servers:ci` runs each scenario in its own test process with a 20-minute
  limit, so a hung scenario costs one group rather than the job. The job summary
  shows passed, failed, timed-out and NOT RUN counts for each selected server
  and how many tests belong to servers outside the run. A failed or timed-out
  scenario, or a NOT RUN that is not a listed exception, fails the job.
- On a failure the container logs (IIS logs on Windows) are uploaded as an
  artifact. A scheduled failure opens or updates the issue
  "Scheduled server matrix failed".

## Adding a server

1. Add the service to `src-tauri/tests/docker/matrix/docker-compose.yml` with
   a profile, `127.0.0.1` port bindings, a healthcheck and, for FTP, a passive
   range of at most ten ports that no other service uses. Reuse an image from
   `images/` where one fits; configs go in `config/<image>/`.
2. If it needs fixtures, mount its data volume in the matching `seed-*` service.
3. Add it to `servers.json` so `servers:up` and `servers:status` print it.
4. Add a `Target` in `src-tauri/tests/server_matrix/targets.rs`. Describe how the
   server differs with the target's flags (hidden dot-files, no symlinks, upload
   limit, connection limit and so on) rather than special-casing its id in a
   scenario.
5. Add the target to the `matrix!` lists in `src-tauri/tests/server_matrix/main.rs`,
   and add `specific!` tests for anything only this server shows.
6. Record behaviour you confirmed by hand in the matrix README, under
   "Behaviour confirmed while building the matrix".
7. Run `npm run servers:up -- <profile>` and `npm run servers:ci -- <profile>`.
