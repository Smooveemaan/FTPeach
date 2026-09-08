# Dependency and supply-chain policy

- Dependabot groups minor/patch updates monthly. Major updates are manual and
  require a migration note plus the full `npm run check` suite.
- Changes to `suppaftp`, `russh`, `russh-sftp`, `reqwest`, `rustls`, Tauri or
  Tauri plugins must link the upstream changelog/security advisory in the PR.
- CI rejects high/critical npm advisories and all unacknowledged RustSec
  advisories. Exceptions must be narrow, documented and time-bounded.
- Runtime dependencies must use an OSI-approved license. `GPL`, `AGPL`,
  `SSPL`, unlicensed and unknown packages require explicit owner review.
- Runtime license texts are bundled from `docs/legal/NPM_THIRD_PARTY_LICENSES.txt`
  and `docs/legal/RUST_THIRD_PARTY_LICENSES.txt`. After changing either lock file, install
  `cargo-about` and run `npm run licenses:generate`; CI runs
  `npm run licenses:check` and rejects stale reports.
- GitHub Actions are pinned to reviewed full commit SHAs, with the corresponding
  release tag recorded in a comment. Dependabot proposes updates; action changes
  receive the same review as dependency changes.
- Secrets never belong in manifests, lockfiles, workflow arguments, fixtures
  or release/dependency scripts. `check:tracked-secrets` runs in every CI job.
- FTPeach does not send telemetry. Any future telemetry requires a separate
  design decision, disabled-by-default implementation and explicit consent.
