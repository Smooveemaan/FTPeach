# Test server matrix

Real FTP/FTPS, SFTP and WebDAV implementations in many configurations, plus
SOCKS/HTTP proxies and a fault-injection proxy. It is separate from
`../docker-compose.yml`, which CI and the release gate use; that stack is the
`baseline` profile here and is not modified.

## Running

```sh
npm run servers:up -- ftp sftp        # build, start, wait for healthchecks, print logins
npm run servers:up -- all             # ftp sftp webdav proxy baseline
npm run servers:up -- heavy           # Nextcloud; first start takes several minutes
npm run servers:status
npm run servers:down                  # add --volumes to drop fixtures, --baseline for the CI stack
```

Profiles: `ftp`, `sftp`, `webdav`, `heavy` (Nextcloud), `proxy`, `chaos`
(Toxiproxy in front of `vsftpd`, `openssh-chroot` and `apache-basic`), and
`baseline`. SFTPGo belongs to `ftp`, `sftp` and `webdav`.

Everything is published on 127.0.0.1 only. All profiles together, Nextcloud
included, idle at about 750 MB of RAM; transfers and Nextcloud indexing add to
that. Images and seeded volumes take a few GB of disk.

`servers.json` is the catalog: server id, compose service, address, login and
what the server is for. `servers:up` and `servers:status` print it.

IIS FTP and IIS WebDAV run on the Windows host, not in Docker:
`scripts/test-servers/iis.ps1 install|uninstall|status` (elevated; it changes
the machine). It works on Windows 11 Home, and relaunches itself in Windows
PowerShell 5.1 because the DISM and WebAdministration modules fail under
PowerShell 7. `install` enables the IIS features that were off, creates the
local user, a self-signed certificate, fixtures under
`C:\ftpeach-test-servers\iis` and the three sites, and stops IIS's Default Web
Site when it brought IIS in; `uninstall` reverts all of it. The sites are in
the catalog as the `iis` profile; `servers:status` lists them when their ports
answer.

## Ports

| Server | Port(s) | Passive range |
| --- | --- | --- |
| vsftpd / _reuse / _nat | 2141 / 2142 / 2143 | 31000-31029 |
| vsftpd_implicit | 2990 | 31030-31039 |
| proftpd / _tls12 / _tls13 | 2151 / 2152 / 2153 | 31100-31129 |
| proftpd_badcert_expired / _cn | 2154 / 2155 | 31130-31149 |
| pyftpdlib / _epsv_only / _nonutf8 | 2161 / 2162 / 2163 | 31200-31229 |
| sftpgo FTP / SFTP / WebDAV | 2171 / 2251 / 18121 | 31300-31309 |
| openssh_keys / _kbdint / _legacy / _modern / _chroot | 2231-2235 | |
| proftpd_sftp / dropbear | 2241 / 2261 | |
| apache_basic / _digest / _https | 18081 / 18082 / 18443 | |
| nginx_davext / nginx_norange_h2 | 18091 / 18444 | |
| webdav_subpath (HTTP, redirects to HTTPS) | 18131 -> 18445 | |
| rclone_webdav / nextcloud | 18111 / 18101 | |
| dante SOCKS5+4 / dante_auth / threeproxy SOCKS4a | 11080 / 11081 / 11082 | |
| squid / squid_auth (HTTP CONNECT) | 13128 / 13129 | |
| toxiproxy API / proxies | 8474 / 19000-19009 | |
| IIS FTP / IIS FTP Unix / IIS WebDAV (host) | 2121 / 2122 / 18180 | 32000-32009 |

Proxies sit on 11080+ and 13128+ rather than the usual 1080/3128, which local
proxy tools often hold. The existing stack keeps 2131, 2222, 6065, 6443, 6444
and 30000-30009.

## Credentials and generated material

`testuser` / `testpass` everywhere, except: `readonly` / `testpass` and
`anonymous` on proftpd; `proxyuser` / `proxypass` on the authenticating
proxies; `ftpeach_test` / `FTPeach-test-2026!` on IIS.

The `prepare` service writes `generated/` (git-ignored):

- `generated/tls/`: `ca.pem` (test CA), `localhost.pem`, `expired.pem`,
  `wrong-cn.pem`, `self-signed.pem`, each with its `.key`. Valid for 7 days,
  regenerated when less than a day is left.
- `generated/keys/`: `id_ed25519`, `id_rsa`, `id_ecdsa`,
  `id_ed25519_passphrase` (passphrase `keypass`) and `authorized_keys`.

## Fixtures

The `seed-*` services write `fixtures/` into each server's data directory
(`seed/seed.py`): Unicode and awkward names (Cyrillic, CJK, emoji, spaces,
leading dash, `#%&+;`, a 255-byte name, names differing only in case),
`many/` with 10 000 files, `deep/` 30 levels, `sizes/` (empty, small, `big.bin`
of `FTPEACH_MATRIX_BIG_MB` MiB, default 64), `hidden/` dot-files, `links/`
(file, directory and broken symlinks), `perms/` (unreadable file and directory,
read-only directory) and, on `pyftpdlib_nonutf8`, cp1251 names in `encoding/`.
Seeding is skipped when the fixtures already match; tests write into their own
per-run directories next to `fixtures/`.

Servers with a `small/` directory mount a 16 MiB tmpfs there for disk-full
tests: vsftpd, proftpd, openssh_chroot (`/small`), apache_basic, nginx_davext.

## Behaviour confirmed while building the matrix

Checked with curl, OpenSSH and openssl against the running containers:

- `vsftpd_reuse` answers `522` to a data connection that does not resume the
  control TLS session (curl with Schannel does not). ProFTPD requires the same
  by default; the proftpd targets turn it off so they test TLS versions and
  certificates alone.
- `vsftpd_nat` advertises `10.255.255.1`; a client that trusts the PASV address
  times out. `pyftpdlib_epsv_only` answers `502` to PASV.
- `proftpd_tls12` / `_tls13` refuse the other TLS version; the bad-certificate
  targets fail verification against the test CA as expired / hostname mismatch.
- `openssh_kbdint` refuses the `password` method; `openssh_legacy` is unreachable
  for a default modern client; `openssh_modern` refuses RSA keys. libssh2
  (curl) cannot negotiate with the default OpenSSH 10 servers at all.
- OpenSSH 10 penalises an address after failed or unauthenticated connections;
  every test comes from the same Docker gateway address, so the configs set
  `PerSourcePenalties no`.
- `nginx_davext` answers `409` to MKCOL without a trailing slash and `413` above
  8 MiB; `nginx_norange_h2` answers ranged GETs with `200` and negotiates h2;
  `apache_digest` rejects Basic with `401`.
- Dante does not implement SOCKS4a, hence `threeproxy`.
- Nextcloud does not index the 255-byte fixture name (its limit is 250).
- Behind Toxiproxy only the FTP control connection is proxied; passive data
  goes straight to vsftpd, which therefore runs with `pasv_promiscuous=YES`.
- IIS FTP replaces every non-ASCII character in names with `?` (one per UTF-16
  unit, so the loss is irreversible) until the client sends `OPTS UTF8 ON`,
  although FEAT advertises `UTF8`. FEAT has no `MLST`, so listings must be
  parsed from LIST: MS-DOS style on `iis_ftp`, Unix style with `owner`/`group`
  placeholders and `drwxrwxrwx` on `iis_ftp_unix`. Explicit FTPS is optional
  and a wrong password gives `530`.
- IIS WebDAV returns absolute `href`s (`http://127.0.0.1:18180/...`), leaves
  PUT out of the `Allow` header although PUT works, answers `200` to DELETE,
  resolves paths case-insensitively (`case.txt` serves `Case.txt`) and refuses
  `web.config` with `404` (request filtering).
