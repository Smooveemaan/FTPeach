# Development

FTPeach uses **React and TypeScript** for the interface and **Rust with Tauri** for the desktop application.

## Prerequisites

Use Windows 10/11 x64 with:

- Node.js 24 and npm;
- Rust installed through rustup, using the pinned MSVC toolchain in [rust-toolchain.toml](../rust-toolchain.toml);
- Visual Studio Build Tools with the C++ build tools and Windows SDK;
- the WebView2 Runtime.

The pinned Rust toolchain includes `clippy`, `rustfmt`, and `rust-analyzer`, keeping editor tooling and pull-request checks consistent.

## Set up and run

Clone the repository and install JavaScript dependencies:

```powershell
git clone https://github.com/Smooveemaan/ftpeach.git
cd ftpeach
npm ci
```

Start the desktop app with hot reload:

```powershell
npm run dev
```

The npm commands below are plain Cargo and Tauri commands; a few that need their own target directory or more than one step go through [scripts/cargo.ts](../scripts/cargo.ts).

## Everyday commands

Run these from the repository root:

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the desktop app with hot reload. |
| `npm run dev:renderer` | Start Vite for browser-only interface work; native operations require the desktop app. |
| `npm test` | Run TypeScript unit tests and React component tests. |
| `npm run lint` | Check lint rules, feature boundaries, and TypeScript types. |
| `npm run format:check` | Check formatting without changing files. |
| `npm run build` | Build the renderer and check bundle size budgets. |
| `npm run rust:check` | Lint the backend as it ships, without running tests; a warning fails it. |
| `npm run rust:test` | Run the Rust tests; ignored ones, such as those that need Docker or live servers, do not run. |
| `npm run rust:build:release` | Build the native release executable without packaging an installer. |
| `npm run build:tauri` | Build the production installer and signed update artifacts; requires updater signing credentials. |
| `npm run check` | Run every check CI runs, including coverage, browser tests, Clippy, licenses, and build checks. |
| `npm run clean` | Remove generated output, reports, and native build caches; see [cleanup options](#clean-up-build-output). |

For a local release executable, run `npm run build` followed by `npm run rust:build:release`. Installer builds require the signing setup described in [updater signing](updater-signing.md); their output is under `%LOCALAPPDATA%\FTPeachBuild\target\release\bundle\nsis`.

## Visual tests and validation

Install the pinned Chromium and WebKit browsers before running visual tests or the full check suite:

```powershell
npx playwright install chromium webkit
npm run test:visual
```

Visual tests use a deterministic application fixture with checked-in snapshots for the workspace and dialogs. Review intentional visual changes before updating snapshots with `npm run test:visual:update`.

`npm run check` runs every CI check and takes about an hour. Installer tests run separately. The end-to-end and live-server suites are closed and run before each release; see [how releases are verified](release-trust.md#how-releases-are-verified).

See the [test guide](../test/README.md) for individual suites and the [contribution guide](../.github/CONTRIBUTING.md) for review expectations.

## Clean up build output

Preview the cleanup targets with `npm run clean -- --dry-run`. Use `npm run clean -- --artifacts-only` to remove generated output and reports while retaining native build caches.

`npm run clean` also removes native and fuzz build caches, including `%LOCALAPPDATA%\FTPeachBuild` outside the repository on Windows. The next build recreates removed output. Both modes preserve `node_modules/` and private working materials in `.local/`.

See the [script guide](../scripts/README.md) for benchmarks, release tooling, and cleanup details.
