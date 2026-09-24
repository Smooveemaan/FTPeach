# Documentation

## Code and development

- [Architecture](architecture.md): Rust modules and application boundaries.
- [Frontend architecture](frontend-architecture.md): feature ownership and import rules.
- [Frontend performance](frontend-performance.md): measurements and reproducible benchmarks.
- [Regression coverage](regression-coverage.md): test scenarios and remaining coverage gaps.
- [Verification matrix](verification-matrix.md): lanes, ignored tests, protocol contracts under faults and the release matrix.
- [Test server matrix](test-server-matrix.md): the client against many real servers, proxies and faulty links; running it and adding a server.
- [Code coverage](coverage.md): what each runner measures, the floors and the baseline.
- [Duplication](duplication.md): the per-area gate, its baseline and the decisions on each clone.
- [Transfer store baseline](optimization-baseline.md): reproducible queue and listing benchmarks.
- [Decision records](adr/): choices that are easy to question later, with their reasons.
- [Scripts](../scripts/README.md) and [tests](../test/README.md): commands and directory layout.

## Runtime behavior

- [User guide](user-guide.md): what the client does when a transfer stops, a file exists or a server is new, each statement backed by a check ([manual checks](manual-checks.md) record the ones a person ran).
- [Protocol support](protocol-support.md) and [networking](networking.md).
- [Storage](storage.md) and [transfer safety](transfer-safety.md).
- [Resilience design](p2-resilience.md), [lifecycle and resource budgets](optimization-lifecycle.md) and [native validation](native-validation.md).

## Security and releases

- [Security design](security.md) and [IPC permissions](ipc-permissions.md).
- [Dependency policy](dependency-policy.md) and [Rust advisories](rust-advisories.md).
- [Updater signing](updater-signing.md), [what a release proves](release-trust.md) and [GitHub automation](github.md).
- [Third-party notices](legal/THIRD_PARTY_NOTICES.txt) and [asset provenance](legal/ASSET_PROVENANCE.md).

## Workspace outputs

Source code lives in `src/` and `src-tauri/src/`; scripts, fixtures, styles and
translations follow the ownership maps above. Root-level tool configuration stays
next to `package.json` so existing commands and editor discovery work directly.

`dist/`, `test-results/`, `playwright-report/` and `release/` are generated output.
`.tools/` contains native SDKs and build tools; `.local/` contains private working
material, with audit logs grouped in `.local/logs/`. These directories are ignored
by Git. Use the documented cleanup command rather than removing SDKs or dependency
caches during routine housekeeping.
