# GitHub repository setup

The public repository is `Smooveemaan/FTPeach`. Workflow responsibilities are
listed in [the GitHub configuration guide](../.github/WORKFLOWS.md).

## Before pushing

- Run `npm run check` from the repository root and review the result. CI also
  runs supply-chain, SAST, protocol compatibility and packaged application checks.
- Review the exact commits that will be published. The tracked secret check
  inspects current working files, not previous commits, and ignoring or
  deleting a file does not remove it from history.
- Exclude local settings, credentials, private keys, assistant instructions,
  development notes, logs and generated output. Review screenshots for private
  server names, addresses and paths.
- After a dependency or asset change, verify [asset provenance](legal/ASSET_PROVENANCE.md), the [license](../LICENSE)
  and [third-party notices](legal/THIRD_PARTY_NOTICES.txt).

## Repository settings

These settings live on GitHub and must be verified separately; committed workflow
files do not establish that they are enabled.

- Protect `master` and the `v*` release tags with the rulesets in
  [`.github/rulesets/`](../.github/rulesets/): on GitHub, open **Settings → Rules →
  Rulesets → New ruleset → Import a ruleset** and import each file.
  - `master.json` blocks deletion and force pushes, requires linear history and a
    pull request merged by squash or rebase, with resolved review threads, and
    requires every job of `checks.yml` as reported by `ci.yml` (`checks / <job>`),
    on a branch that is up to date with `master`. A job skipped by the change
    filter counts as passing; `changes` is required so that a failed filter
    cannot skip the rest. When a job is added to or renamed in `checks.yml`,
    update this list.
  - `release-tags.json` blocks creating, moving and deleting `v*` tags, which
    trigger a signed release.
  - Repository administrators bypass both rulesets, so the maintainer can still
    push to `master` and tag releases directly.
- Enable private vulnerability reporting so the route in [SECURITY.md](../SECURITY.md)
  is available. Enable secret scanning and push protection where available.
- Configure the protected `release` environment and its signing secrets as
  described in [updater signing](updater-signing.md).
- Set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**
  so `pages.yml` can publish the website, and set the repository's website to
  <https://ftpeach.com/>.
- Verify the repository description, default branch and issue labels.

## CI on forks

`ci.yml` uses `pull_request`, with read-only checkout permissions and
`persist-credentials: false`. Keep pull-request jobs independent of signing
secrets. Release signing belongs to the protected release environment and the
tag-triggered release workflow.

## Public release review

Review the draft release's version, installer, signatures, update manifest,
SBOMs and release notes before publishing. Check a clean Windows installation
and the update path using the [native validation guide](native-validation.md).
