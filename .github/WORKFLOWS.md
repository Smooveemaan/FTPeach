# GitHub configuration

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `ci.yml` | Push to `master`, pull request, manual full run | Calls the shared verification suite; a newer push to a pull request cancels its older run, while every push to `master` runs to the end. |
| `checks.yml` | Reusable workflow | Ordinary pushes run baseline checks plus lint, tests, build and SAST for the affected code. Coverage, visual tests, language layout audits and cross-platform builds run only for releases or manual full CI. Parser changes also replay saved regression inputs. |
| `release.yml` | Push of a `v*` tag; manual run on a tag only to skip the closed suites with a reason | Runs all checks and installer tests, requires a green `private-suites` status on the tagged commit ([How releases are verified](../docs/release-trust.md#how-releases-are-verified)), checks that the `release` environment requires approval, then builds signed Windows artifacts, SBOMs, a provenance attestation and a trust report in a draft release ([release-trust.md](../docs/release-trust.md)). |
| `pages.yml` | Push to `master` touching site inputs, guide Markdown, npm dependencies or its workflow, a published release, daily at 04:17 UTC, manual run | Builds the home page and `docs/guide/` with shared styles and fonts, the latest release's download links and public counts, then deploys them to GitHub Pages. |
| `security-audit.yml` | Monday at 04:17 UTC, manual run | Reviews Rust advisories and fuzzes protocol parsers. |
| `i18n-audit.yml` | Tuesday at 04:37 UTC, manual run | Runs the visual layout audit in every language and the pseudo-locale. |
| `installer.yml` | Reusable release gate, manual run | Tests clean installation, upgrade, uninstall and installed/portable updates using signed test builds. |

## Maintenance

- Keep shared verification steps in `checks.yml`; keep `npm run check` aligned with `npm run check:ci-parity`.
- `scripts/checks/classify-changes.ts` selects job IDs directly; every conditional job consumes that list. Tests in `test/unit/tooling/classifyChanges.test.ts` cover path selection and workflow wiring. Rust `include_str!`/`include_bytes!` inputs select Rust checks alongside their other consumers. Unknown paths select all ordinary code checks. Website publishing and installer verification remain in their own workflows.
- Inside `supply-chain`, locale validation, generated docs, guide test links and formatting run only when their inputs change. Security checks always run. Full runs include all four checks; if classification fails, all four run as a fallback.
- Changes to check tooling run its unit tests, lint and the existing blocking checks, without application tests or a build. The `lint-test-build` job keeps its identifier for branch protection. Script-only `package.json` changes select their consumers; other manifest changes and lockfile changes still check the application and website. Pages classifies push contents before installing dependencies or browsers.
- To run the full suite manually, use **Actions → CI → Run workflow**. Releases pass `force-all: true` to the same shared workflow.
- Documents and changelogs are updated when behavior changes; commit exemption trailers are not required. `check:verified-by` validates optional guide links.
- Preserve workflow and job identifiers when editing: branch protection can reference their check names.
- Pin third-party actions to full commit SHAs with version comments, and container images to digests.
- Declare permissions per job and disable persisted checkout credentials.
- `dependabot.yml` checks npm, Cargo and GitHub Actions monthly. npm and Cargo minor/patch updates are grouped; major updates are ignored for manual review.
- `CODEOWNERS` assigns GitHub configuration and security-sensitive files to the repository security owner.

## Contributions

`ISSUE_TEMPLATE/` holds the issue forms for bug reports, feature requests and translation problems; blank issues are off, and `config.yml` links the security policy and the documentation instead. Follow the [security policy](SECURITY.md) for vulnerabilities. Pull requests are not accepted; `PULL_REQUEST_TEMPLATE.md` says so and points to the issues. See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes are made.
