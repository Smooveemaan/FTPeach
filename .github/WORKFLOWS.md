# GitHub configuration

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `ci.yml` | Push to `master`, pull request | Calls the shared verification suite; superseded runs are cancelled. |
| `checks.yml` | Reusable workflow | Supply-chain checks, SAST, lint, tests and builds. Rust, visual and packaged smoke jobs use changed paths; releases force every job. |
| `protocol-compatibility.yml` | Wednesday at 03:43 UTC, manual run, release | Tests disposable FTP/FTPS/SFTP/WebDAV servers. Scheduled failures open or update a regression issue. |
| `release.yml` | Push of a `v*` tag | Runs all checks and protocol tests, then builds signed Windows artifacts and SBOMs in a draft release using the `release` environment. |
| `security-audit.yml` | Monday at 04:17 UTC, manual run | Reviews Rust advisories and fuzzes protocol parsers. |

## Maintenance

- Keep shared verification steps in `checks.yml`; keep `npm run check` aligned with `npm run check:suite-coverage`.
- Preserve workflow and job identifiers when editing: branch protection can reference their check names.
- Pin third-party actions to full commit SHAs with version comments, and container images to digests.
- Declare permissions per job and disable persisted checkout credentials.
- `dependabot.yml` checks npm, Cargo and GitHub Actions monthly. npm and Cargo minor/patch updates are grouped; major updates are ignored for manual review.
- `CODEOWNERS` assigns GitHub configuration and security-sensitive files to the repository security owner. Required owner approval is configured in repository rules.

## Contributions

`ISSUE_TEMPLATE/bug_report.yml` collects reproducible bug reports. Follow the [security policy](../SECURITY.md) for vulnerabilities. `PULL_REQUEST_TEMPLATE.md` records the reason for a change and its verification; see [CONTRIBUTING.md](../CONTRIBUTING.md) for development instructions.
