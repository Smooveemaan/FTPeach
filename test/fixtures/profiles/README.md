# Profile fixtures

Whole `%APPDATA%\FTPeach` folders in each format FTPeach still reads, for the
desktop tests that start the application on them (`test/e2e/profiles.e2e.ts`)
and for any later test of an upgrade.

- `legacy`: schema 0, as installs from before 0.1.0 left it. Every file is the
  bare JSON value without the `{ schemaVersion, data }` envelope, a password is
  in plain text (`plain`), a local path is still in `sites.json`, and one
  password is an Electron-era ciphertext that cannot be read.
- `system`: schema 1 with system protection, as 0.1.0 to 0.4.0 write it: the
  password protected by DPAPI (`enc`), a trusted SSH host key, local paths in
  their own file and a saved session of two tabs.
- `vault`: schema 1 with a master password (`profile fixture master 2026`).
  `vault.json` and `vault.hold` hold the password of the IIS FTP test account
  (`FTPeach-test-2026!`) for the bookmark `vault-ftp`. They were made once by
  the application's own `vault_setup`, and are kept as they are so a change
  that cannot read them shows.

A string value that is a whole placeholder is replaced when a test writes the
profile: `$ftp.host`, `$ftp.port`, `$ftp.user` and `$ftp.password` from the
IIS FTP test server, the same for `$sftp.*`, `$sftp.address` (`host:port`) and
`$sftp.fingerprint` from the OpenSSH one, `$fixtures` with this folder's path,
and `$dpapi:<value>` with the value protected by DPAPI for the account running
the test. Placeholders in object keys are replaced too.
