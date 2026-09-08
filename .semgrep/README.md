# SAST policy

`checks.yml` runs Semgrep 1.176.1 pinned by image digest, with repository-local
rules and no registry rules, token or telemetry. Only `contents: read` is needed.
The job fails on findings and scanner errors from the start; repository branch
protection must require `sast` to prohibit merges (workflow code cannot set that
repository setting). Findings include source locations in the check log.

```sh
semgrep scan --test .semgrep --metrics=off --disable-version-check
semgrep scan --config .semgrep/security.yml --error --strict --metrics=off --disable-version-check src-tauri/src src
```

Rules cover IPC path traversal into direct filesystem calls, disabled TLS
verification, dynamic renderer code and HTML insertion. Adjacent Rust and TSX
fixtures test both vulnerable and safe examples before every scan. This is a
focused baseline, not comprehensive proof of security: Community Edition taint
analysis does not trace across arbitrary application functions. Add regression
fixtures with each new source/sink or sanitizer.

The existing WebDAV `allowInvalidCert` opt-in has one narrow, explained inline
suppression. New suppressions and rule changes require security-owner review.
`safe_temp_name` is the only named path sanitizer; merely joining or normalizing
a user-supplied path is not considered containment validation.

References: [Semgrep CLI](https://docs.semgrep.dev/cli-reference) and
[rule testing](https://semgrep.dev/docs/writing-rules/testing-rules).
