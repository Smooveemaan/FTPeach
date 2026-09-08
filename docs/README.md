# Documentation

## Code and development

- [Architecture](architecture.md): Rust modules and application boundaries.
- [Frontend architecture](frontend-architecture.md): feature ownership and import rules.
- [Frontend performance](frontend-performance.md): measurements and reproducible benchmarks.
- [Regression coverage](regression-coverage.md): test scenarios and remaining coverage gaps.
- [Scripts](../scripts/README.md) and [tests](../test/README.md): commands and directory layout.

## Runtime behavior

- [Protocol support](protocol-support.md) and [networking](networking.md).
- [Storage](storage.md) and [transfer safety](transfer-safety.md).
- [Resilience validation](p2-resilience.md) and [native validation](native-validation.md).

## Security and releases

- [Security design](security.md) and [IPC permissions](ipc-permissions.md).
- [Dependency policy](dependency-policy.md) and [Rust advisories](rust-advisories.md).
- [Updater signing](updater-signing.md) and [GitHub automation](github.md).
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
