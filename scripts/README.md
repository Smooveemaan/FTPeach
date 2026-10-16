# Project scripts

Run commands from the repository root. TypeScript entry points run with Node's
`--experimental-strip-types`; prefer the npm commands in `package.json`.

| Location | Purpose | Entry points |
| --- | --- | --- |
| `checks/` | Repository, architecture, locale, and release validation | `npm run check`, `npm run lint`, `npm run i18n:check` |
| `benchmarks/` | Frontend models, transfer history, and browser measurements | `npm run benchmark:frontend`, `npm run benchmark:transfer-history`, `npm run benchmark:transfer-ui` |
| `release/` | Release notes, license notices, SBOMs, advisory reports, the release-environment gate and the trust report | `npm run licenses:check`, `npm run sbom:generate`; CI runs the rest |
| `packaged-smoke/` | Native application smoke harness | [Instructions](packaged-smoke/README.md) |
| `manual-tests/` | Manual file-type icon fixtures | [Instructions](manual-tests/README.md) |
| `test-servers/` | The IIS FTP and WebDAV sites and the OpenSSH server the installer tests connect to, on the Windows host | `iis.ps1 install`, then `openssh.ps1 install`, in an elevated PowerShell |
| `site/` | Builds the website for GitHub Pages and draws its link previews | `npm run site:build`, `npm run site:social` |
| `with-libsodium.ps1` | Verified native library setup and Cargo/Tauri commands | `npm run rust:check`, `npm run build:tauri` |
| `clean.ps1` | Build output and cache cleanup | `npm run clean` |

Checks report failures with a nonzero exit code. The boundary checkers also export
functions exercised by `test/unit/tooling`. Benchmarks retain their datasets,
warmups, and sampling rules so results remain comparable.

Release generators write artifacts, and the advisory report uses Cargo and
public network services. Cleanup removes generated directories; it is not part
of validation.

Use `npm run clean -- -WhatIf` to preview cleanup paths. Use
`npm run clean -- -ArtifactsOnly` to remove generated frontend output, reports and
Tauri schemas/permissions while keeping native build caches (including fuzz targets).
Reports include coverage and duplication output. Local audit logs belong in
`.local/logs/`; `.local/`, `.tools/` SDKs and `node_modules/` are retained by cleanup.

## Website palette previews

The README screenshots, the palette previews and the website demos are captured
from the running application by the maintainer's tooling and are never edited by
hand.

`npm run site:build` copies the individual palette previews and their picker script
into `dist-site/`. The picker starts in the page's theme and downloads new previews
on demand. Its light/dark buttons override the preview mode independently of the
page. The header theme switch resets that override and changes the preview in the
same page transition. Browser coverage lives in `test/visual/website-palettes.spec.ts`.
