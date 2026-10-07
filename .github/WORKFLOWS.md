# GitHub configuration

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `ci.yml` | Push to `master`, pull request | Calls the shared verification suite; superseded runs are cancelled. |
| `checks.yml` | Reusable workflow | Supply-chain checks, SAST, lint, tests and builds. Rust, visual and packaged smoke jobs use changed paths; releases force every job. |
| `protocol-compatibility.yml` | Wednesday at 03:43 UTC, manual run, release, push to `master` or pull request touching Rust sources, tests or Cargo manifests | Tests disposable FTP/FTPS/SFTP/WebDAV servers. Scheduled failures open or update a regression issue. |
| `release.yml` | Push of a `v*` tag | Runs all checks and protocol tests, checks that the `release` environment requires approval, then builds signed Windows artifacts, SBOMs, a provenance attestation and a trust report in a draft release ([release-trust.md](../docs/release-trust.md)). |
| `pages.yml` | Push to `master` touching `site/`, the images or the site build, a published release, manual run | Builds the website from `site/index.html` with the latest release's download links and deploys it to GitHub Pages. |
| `server-matrix.yml` | Saturday at 04:17 UTC, manual run | Runs the [test server matrix](../docs/test-server-matrix.md) by profile against many real servers, proxies and faulty links. Informational, never a gate; scheduled failures open or update a regression issue. |
| `security-audit.yml` | Monday at 04:17 UTC, manual run | Reviews Rust advisories and fuzzes protocol parsers. |

## Maintenance

- Keep shared verification steps in `checks.yml`; keep `npm run check` aligned with `npm run check:ci-parity`.
- Which changed paths select which jobs is decided by `scripts/checks/classify-changes.ts`, covered by `test/unit/tooling/classifyChanges.test.ts`. Files one side compiles from the other — the JSON under `src/` that the Rust crate includes — are listed there and select both.
- `lint-test-build` runs `check:docs-impact` over the pushed range: code linked to a document in `scripts/checks/check-doc-impact.ts`, and any change to the app, must come with that document and a changelog line, or with `Docs-Impact:` / `Changelog:` trailers giving the reason. `check:verified-by` keeps every statement in the user guide tied to a test that runs.
- Preserve workflow and job identifiers when editing: branch protection can reference their check names.
- Pin third-party actions to full commit SHAs with version comments, and container images to digests.
- Declare permissions per job and disable persisted checkout credentials.
- `dependabot.yml` checks npm, Cargo and GitHub Actions monthly. npm and Cargo minor/patch updates are grouped; major updates are ignored for manual review.
- `CODEOWNERS` assigns GitHub configuration and security-sensitive files to the repository security owner. Required owner approval is configured in repository rules.

## Contributions

`ISSUE_TEMPLATE/` holds the issue forms for bug reports, feature requests and translation problems; blank issues are off, and `config.yml` links the security policy and the documentation instead. Follow the [security policy](SECURITY.md) for vulnerabilities. `PULL_REQUEST_TEMPLATE.md` records the reason for a change and its verification; see [CONTRIBUTING.md](CONTRIBUTING.md) for development instructions.
