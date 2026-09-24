# SAST policy

`checks.yml` runs Semgrep 1.176.1 pinned by image digest, with repository-local
rules and no registry rules, token or telemetry. Only `contents: read` is needed.
The job fails on findings and scanner errors from the start; repository branch
protection must require `sast` to prohibit merges (workflow code cannot set that
repository setting). Findings include source locations in the check log.

```sh
semgrep scan --test --config .semgrep/security.yml .semgrep/security.rs --metrics=off --disable-version-check
semgrep scan --test --config .semgrep/security.yml .semgrep/security.tsx --metrics=off --disable-version-check
semgrep scan --config .semgrep/security.yml --error --strict --metrics=off --disable-version-check src-tauri/src src
```

Run the fixtures one file at a time. Given the `.semgrep` directory, this
Semgrep version answers "No unit tests found" and exits 0; with several targets
it refuses to test at all. CI therefore also requires "All tests passed" in the
output.

Rules cover:

- IPC path traversal into direct filesystem calls;
- disabled TLS verification;
- a derived `Debug` on a struct holding a password, passphrase, secret, token
  or private key as a plain `String`/`Vec<u8>` (use `SensitiveString`);
- unbounded channels outside tests, since the sender may be a server or the
  renderer;
- the raw `showSecurityConfirmations`/`vaultAutoLockMinutes`/`strictHostKeyCheck` keys outside
  `security_policy.rs`, so a new path that changes them has to go through the
  policy that decides what counts as weakening;
- dynamic renderer code and HTML insertion.

A new app command without a window ACL decision is caught by
`npm run check:command-acl`, not by Semgrep: that check compares the registered
commands with the manifest and both capability files.

Adjacent Rust and TSX fixtures test both vulnerable and safe examples before
every scan. This is a focused baseline, not comprehensive proof of security:
Community Edition taint analysis does not trace across arbitrary application
functions. Add regression fixtures with each new source/sink or sanitizer.

The existing WebDAV `allowInvalidCert` opt-in has one narrow, explained inline
suppression. New suppressions and rule changes require security-owner review.
`safe_temp_name` is the path sanitizer, and `OpenWithIntent::resolve` is named
as one because it derives `local_name` with it; merely joining or normalizing a
user-supplied path is not considered containment validation.

References: [Semgrep CLI](https://docs.semgrep.dev/cli-reference) and
[rule testing](https://semgrep.dev/docs/writing-rules/testing-rules).
