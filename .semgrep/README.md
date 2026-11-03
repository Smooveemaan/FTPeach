# SAST policy

`checks.yml` and `npm run check:sast` run Semgrep 1.176.1 pinned by the same
image digest, with repository-local rules and no registry rules, token or
telemetry. Only `contents: read` is needed. The job fails on findings and
scanner errors from the start; repository branch protection must require `sast`
to prohibit merges (workflow code cannot set that repository setting). Findings
include source locations in the check log.

The local command runs these fixture checks before the source scan:

```sh
semgrep scan --test --config .semgrep/security.yml .semgrep/security.rs --metrics=off --disable-version-check
semgrep scan --test --config .semgrep/security.yml .semgrep/security.tsx --metrics=off --disable-version-check
semgrep scan --config .semgrep/security.yml --error --strict --metrics=off --disable-version-check src-tauri/src src
```

The local application scan copies `.git`, `.gitignore`, `.semgrep`, `src` and
`src-tauri/src` from the Docker bind mount into the container's temporary
filesystem before running the same command. This preserves Git-based target
selection while avoiding slow repeated reads through Docker Desktop's Windows
bind mount. Fixtures still run directly from `/src`.

Fixtures run one file at a time. Given the `.semgrep` directory, this Semgrep
version answers "No unit tests found" and exits 0; with several targets it
refuses to test at all. Both local and CI runs therefore require "All tests
passed" in each fixture's output and stop before the scan when it is absent.

Rules cover:

- IPC parameters reaching direct filesystem calls, including directory
  reading/removal, link and open/create operations; Tauri-provided `State`,
  `AppHandle` and `WebviewWindow` parameters are not IPC data sources;
- disabled TLS verification;
- a derived `Debug` on a struct or enum holding a password, passphrase, secret,
  token or private key as a plain string, string collection or binary value;
- unbounded channels outside tests, since the sender may be a server or the
  renderer;
- the raw `showSecurityConfirmations`/`vaultAutoLockMinutes`/`strictHostKeyCheck` keys outside
  `security_policy.rs`, so a new path that changes them has to go through the
  policy that decides what counts as weakening;
- dynamic renderer code and HTML insertion.

Use `SensitiveString` for one string and redacted wrappers for collections and
binary secrets, including `Vec<SensitiveString>` for string collections, or do
not derive `Debug`.

A new app command without a window ACL decision is caught by
`npm run check:command-acl`, not by Semgrep: that check compares the registered
commands with the manifest and both capability files.

Adjacent Rust and TSX fixtures test both vulnerable and safe examples before
every scan. This is a focused baseline, not comprehensive proof of security:
Community Edition taint analysis does not trace across arbitrary application
functions. `create_dir`/`create_dir_all` are not sinks yet because intentional
creation of an arbitrary user-selected directory needs a separate trust
classification. Add regression fixtures with each new source/sink or sanitizer.

The existing WebDAV `allowInvalidCert` opt-in has one narrow, explained inline
suppression. New suppressions and rule changes require security-owner review.
`safe_temp_name` is the path sanitizer; merely joining or normalizing a
user-supplied path is not containment validation. `OpenWithIntent::resolve`
leaves `remote_path` untrusted and sanitizes only `local_name`. `application`
is separately validated as an approved canonical program path for launch,
`connection_id` is an authorization identifier, and `executable` is a derived
boolean; none is a filesystem-path sanitizer.

When updating Semgrep, change its version and digest together in `checks.yml`,
`scripts/checks/sast.ts` and this document. `check:ci-parity` compares the full
local and CI image references. Run `npm run check:sast` and review findings,
scanner errors and parsed-line coverage against the previous version; explain
unexpected differences rather than requiring identical diagnostics.

References: [Semgrep CLI](https://docs.semgrep.dev/cli-reference) and
[rule testing](https://semgrep.dev/docs/writing-rules/testing-rules).
