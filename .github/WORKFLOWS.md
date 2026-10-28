# GitHub configuration

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `ci.yml` | Push to `master`, pull request | Calls the shared verification suite; a newer push to a pull request cancels its older run, while every push to `master` runs to the end. |
| `checks.yml` | Reusable workflow | Supply-chain checks, SAST, lint, tests and builds. SAST, Rust, visual and packaged smoke jobs use changed paths; releases force every job. |
| `release.yml` | Push of a `v*` tag; manual run on a tag only to skip the closed suites with a reason | Runs all checks and installer tests, requires a green `private-suites` status on the tagged commit ([How releases are verified](../docs/release-trust.md#how-releases-are-verified)), checks that the `release` environment requires approval, then builds signed Windows artifacts, SBOMs, a provenance attestation and a trust report in a draft release ([release-trust.md](../docs/release-trust.md)). |
| `pages.yml` | Push to `master` touching site inputs, guide Markdown, npm dependencies or its workflow, a published release, daily at 04:17 UTC, manual run | Builds the home page and `docs/guide/` with shared styles and fonts, the latest release's download links and public counts, then deploys them to GitHub Pages. |
| `security-audit.yml` | Monday at 04:17 UTC, manual run | Reviews Rust advisories and fuzzes protocol parsers. |
| `i18n-audit.yml` | Tuesday at 04:37 UTC, manual run | Runs the visual layout audit in every language and the pseudo-locale. |
| `installer.yml` | Reusable release gate, manual run | Tests clean installation, upgrade, uninstall and installed/portable updates using signed test builds. |

## Maintenance

- Keep shared verification steps in `checks.yml`; keep `npm run check` aligned with `npm run check:ci-parity`.
- Which changed paths select which jobs is decided by `scripts/checks/classify-changes.ts`, covered by `test/unit/tooling/classifyChanges.test.ts`. Files one side compiles from the other — the JSON under `src/` that the Rust crate includes — are listed there and select both.
- `lint-test-build` runs `check:docs-impact` over the pushed range: code linked to a document in `scripts/checks/check-doc-impact.ts`, and any change to the app, must come with that document and a changelog line, or with `Docs-Impact:` / `Changelog:` trailers giving the reason. `check:verified-by` validates the guide's references to runnable tests or recorded manual checks.
- Preserve workflow and job identifiers when editing: branch protection can reference their check names.
- Pin third-party actions to full commit SHAs with version comments, and container images to digests.
- Declare permissions per job and disable persisted checkout credentials.
- `dependabot.yml` checks npm, Cargo and GitHub Actions monthly. npm and Cargo minor/patch updates are grouped; major updates are ignored for manual review.
- `CODEOWNERS` assigns GitHub configuration and security-sensitive files to the repository security owner. Required owner approval is configured in repository rules.

## Contributions

`ISSUE_TEMPLATE/` holds the issue forms for bug reports, feature requests and translation problems; blank issues are off, and `config.yml` links the security policy and the documentation instead. Follow the [security policy](SECURITY.md) for vulnerabilities. Pull requests are not accepted; `PULL_REQUEST_TEMPLATE.md` says so and points to the issues. See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes are made.
