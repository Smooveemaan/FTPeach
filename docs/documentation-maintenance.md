# Documentation maintenance

This inventory assigns each current document an owner and a public check. Use it
when changing code: update the document that owns the behavior, not whichever
linked page is easiest to edit. Keep one fact in one place and link to it.

Two kinds of content can share a page:

- **A — generated.** A deterministic block derived from a machine-readable source.
  Change the source and regenerate the block; never edit it by hand.
- **B — authored.** Explanations, guarantees, limitations and instructions written
  by a person. Tests and recorded manual checks support them but do not replace
  review of what the text says.

The control column describes the current public mechanism. A path-to-document
link requires a documentation change or an explained `Docs-Impact: none`; a
`verified-by` marker names a test or recorded manual check. Neither proves that
every sentence is correct.

## User guide

| Document | Source or owner | Type | Current control |
| --- | --- | --- | --- |
| [Getting started](guide/getting-started.md) | `src/`, connection and transfer code | B | `verified-by` |
| [Interface](guide/interface.md) | `src/app/`, `src/features/`, `src/shared/` | B | `verified-by` |
| [Connecting](guide/connecting.md) | `src/features/sites/`, `src-tauri/src/application/`, `src-tauri/src/protocol/` | B | `verified-by`; protocol doc-impact links |
| [FTP](guide/ftp.md) | `src-tauri/src/protocol/ftp*` | B | `verified-by`; protocol doc-impact links |
| [FTPS](guide/ftps.md) | `src-tauri/src/protocol/ftp*`, TLS configuration | B | `verified-by`; protocol doc-impact links |
| [SFTP](guide/sftp.md) | `src-tauri/src/protocol/sftp*`, SSH configuration | B | `verified-by`; protocol doc-impact links |
| [WebDAV](guide/webdav.md) | `src-tauri/src/protocol/webdav*` | B | `verified-by`; protocol doc-impact links |
| [Transfers](guide/transfers.md) | `src/features/transfers/`, `src-tauri/src/transfer/`, `src-tauri/src/application/` | B | `verified-by`; transfer doc-impact links |
| [Editing](guide/editing.md) | `src/features/open-with/`, backend open-with code | B | `verified-by` |
| [Portable](guide/portable.md) | `src-tauri/src/store/`, portable build and updater code | B | `verified-by`; storage doc-impact links |
| [Passwords](guide/passwords.md) | `src-tauri/src/security/`, `src-tauri/src/store/` | B | `verified-by`; storage/security doc-impact links |
| [Protocol reference](guide/protocol-reference.md) | `src-tauri/src/protocol/` and protocol dependency defaults | B | `verified-by`; SSH algorithm parity test |
| [Troubleshooting](guide/troubleshooting.md) | The behavior page that owns each symptom | B | `verified-by` |

## Architecture and runtime behavior

| Document | Source or owner | Type | Current control |
| --- | --- | --- | --- |
| [Architecture](architecture.md) | `src/`, `src-tauri/src/` ownership and IPC | B | Import, command-ACL and Rust-boundary checks; review |
| [Frontend architecture](frontend-architecture.md) | `src/` | B | `check-feature-boundaries`; review |
| [Storage](storage.md) | `src-tauri/src/store/`, `src/shared/settingsDefaults.json` | B | Storage tests; doc-impact links |
| [Transfer safety](transfer-safety.md) | `src-tauri/src/transfer/`, `src-tauri/src/application/` | B | Transfer tests; doc-impact links |
| [Resilience](resilience.md) | Transfer, session and resource-budget owners | B | Named Rust and frontend tests; review |
| [Networking](networking.md) | `src-tauri/src/protocol/transport*`, `proxy*`, `webdav*` | B | Protocol tests; doc-impact links |
| [Security design](security.md) | `src-tauri/src/security/`, capabilities, updater | B | Security tests; doc-impact links; manual release checks |
| [IPC permissions](ipc-permissions.md) | Command registries, `build.rs`, capabilities | A/B | `check:docs`; `check-command-acl`; packaged smoke test |
| [Glossary](CONTEXT.md) | Product terminology and `src/i18n/locales/en.json` | B | Terminology review |

## Development, checks and releases

| Document | Source or owner | Type | Current control |
| --- | --- | --- | --- |
| [Development](development.md) | `package.json`, build and test configuration | A/B | `check:docs`; command review; CI parity checks |
| [Code coverage](coverage.md) | `scripts/coverage/`, coverage configuration | B | Coverage tooling tests; `check:ci-parity` |
| [Duplication](duplication.md) | `scripts/checks/check-duplicates.ts`, its baseline | B | `check:duplicates`; baseline review |
| [Frontend performance](frontend-performance.md) | Frontend benchmark scripts | B | Reproducible benchmark runs |
| [Transfer store baseline](optimization-baseline.md) | Transfer and listing benchmark scripts | B | Reproducible benchmark runs |
| [Manual checks](manual-checks.md) | Recorded native and manual acceptance runs | B | Maintainer review of each recorded run |
| [Dependency policy](dependency-policy.md) | Manifests, lockfiles, license and advisory checks | B | Supply-chain checks; dependency review |
| [Rust advisories](rust-advisories.md) | `scripts/checks/check-rust-advisory-policy.ts` | B | `check:rust-advisories` |
| [Updater signing](updater-signing.md) | Updater runtime, build and release configuration | B | Updater fixtures; doc-impact links; release checks |
| [Release trust](release-trust.md) | Release workflows and verification suites | B | Release tooling tests; recorded release runs |
| [GitHub automation](github.md) | `.github/workflows/` | B | `check:ci-parity`; workflow review |
| [Asset provenance](legal/ASSET_PROVENANCE.md) | Asset sources and licenses | B | Asset review |

## Scope and known gaps

Navigation pages, link-preservation stubs (`docs/user-guide.md` and
`docs/protocol-support.md`), historical ADRs and generated legal notices are not
behavior inventories and are omitted from the tables.

Frontend changes do not have a dedicated doc-impact mapping: a broad mapping
would fire on most interface edits without identifying the correct page. The
changelog gate, `verified-by` and review remain necessary. Protocol, security,
transfer and performance prose also needs semantic review even when its named
checks still exist. Add a narrower mapping only when a repeated, identifiable
miss justifies it.
