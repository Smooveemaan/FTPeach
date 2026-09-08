# Project scripts

Run commands from the repository root. TypeScript entry points run with Node's
`--experimental-strip-types`; prefer the npm commands in `package.json`.

| Location | Purpose | Entry points |
| --- | --- | --- |
| `checks/` | Repository, architecture, locale, and release validation | `npm run check`, `npm run lint`, `npm run i18n:check` |
| `benchmarks/` | Frontend models, transfer history, and browser measurements | `npm run benchmark:frontend`, `npm run benchmark:transfer-history`, `npm run benchmark:transfer-ui` |
| `release/` | Release notes, license notices, SBOMs, and advisory reports | `npm run licenses:check`, `npm run sbom:generate`; CI runs release notes and advisory reports |
| `i18n/` | Translation synchronization | `npm run i18n:sync -- --help` |
| `packaged-smoke/` | Native application smoke harness | [Instructions](packaged-smoke/README.md) |
| `manual-tests/` | Manual fixtures and historical Electron verification | [Instructions](manual-tests/README.md) |
| `with-libsodium.ps1` | Verified native library setup and Cargo/Tauri commands | `npm run rust:check`, `npm run build:tauri` |
| `clean.ps1` | Build output and cache cleanup | `npm run clean` |

Checks report failures with a nonzero exit code. The boundary checkers also export
functions exercised by `test/unit/tooling`. Benchmarks retain their datasets,
warmups, and sampling rules so results remain comparable.

Translation sync can call the paid DeepL API and writes locale files; use
`--dry-run` to preview. Release generators write artifacts, and the advisory report
uses Cargo and public network services. Cleanup removes generated directories;
it is not part of validation.

Use `npm run clean -- -WhatIf` to preview cleanup paths. Use
`npm run clean -- -ArtifactsOnly` to remove generated frontend output, reports and
Tauri schemas while keeping native build caches. Local audit logs belong in
`.local/logs/`; `.local/`, `.tools/` SDKs and `node_modules/` are retained by cleanup.
