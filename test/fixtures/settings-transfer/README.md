# Settings transfer fixture

`windows-secrets.json` was exported on Windows from a DPAPI-protected bookmark
through `seal_secrets`, using only these synthetic values:

- Export password: `cross-platform export password`
- Server password: `fixture server password`
- SSH key passphrase: `fixture key passphrase`

It uses the unit-test KDF profile (1 MiB, one pass), not the production profile.
`a_windows_export_imports_passwords_into_the_destination_protection` reads the
same bytes on Windows, Linux and macOS, imports into system protection and the
master-password vault, and checks both credentials and their encrypted storage.
Unix unit tests use an in-memory keyring, so this does not verify OS prompts.

To regenerate on Windows, set `FTPEACH_RECORD_WINDOWS_EXPORT=1` and run that test.
Do not regenerate on another platform or substitute real credentials.
