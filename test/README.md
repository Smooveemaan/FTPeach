# Tests

Tests are grouped first by runtime, then by the area they cover. Keep new cases
with their feature's existing suite. Shared setup and test adapters belong in
the owning runtime's `helpers/` directory.

```text
test/
  unit/                  Node tests: pure logic and injected services
    application/         Bootstrap, commands, workspace, menus, shortcuts, vault
    file-browser/        Pane models, navigation and file operations
    sites/               Site models, forms and drag calculations
    transfers/           Queue state, speed and recursive traversal
    settings/            Date formatting and layout reset
    logs/                Log buffer retention
    platform/            IPC contracts, errors and native window helpers
    shared/              Formatting, paths, locale helpers and resize reducer
    tooling/             Repository boundary checker tests
    helpers/             Fake IPC client for pane tests
  component/             Vitest + jsdom + React Testing Library
    application/         Workspace, bootstrap and application state hooks
    file-browser/        File panes and tabs
    sites/               Site manager, drag controller and tree regressions
    transfers/           Transfer hook lifecycle
    settings/            Settings dialog
    logs/                Log panel and connection labels
    open-with/           Open with dialog and edit recovery
    updater/             Update checks and installation
    platform/            Interface scale and Tauri adapter tests
    shared/              Dialogs, menus, drag and resize hooks
    helpers/             Global setup and Tauri test adapter
  visual/                Playwright scenarios, browser harness and snapshots
  e2e/                   The real application driven through its window (CDP); installer tests
  fixtures/updater/      Signed sample update and local fixture server
```

## Commands

| Command | Scope |
| --- | --- |
| `npm test` | Unit tests, then component tests |
| `npm run test:unit` | `test/unit/**/*.test.ts`, using `node:test` |
| `npm run test:components` | `test/component/**/*.test.{ts,tsx}`, using Vitest |
| `npm run test:visual` | Browser scenarios in `test/visual/` |
| `npm run test:e2e:vm` | Installer, uninstall and update tests; only on a disposable Windows machine, see below |
| `npm run test:updater-fixtures` | Accept the valid update signature and reject a damaged artifact |
| `npm run rust:test` | Native Rust tests under `src-tauri/` |

Run one suite while working on a feature:

```sh
node --experimental-strip-types --test test/unit/file-browser/paneNavigation.test.ts
npm run test:components -- test/component/sites/siteManager.test.tsx
```

`npm run check` includes the project checks and test runners. The
`check:ci-parity` command compares its npm steps with `checks.yml`, with explicit
exclusions; it does not measure code coverage or cover every workflow. `npm run coverage` runs both suites with coverage, see
[docs/coverage.md](../docs/coverage.md).
Packaged smoke, Rust coverage, the layout audit and the installer tests run
separately. The end-to-end and server suites are closed and run before every release;
see [how releases are verified](../docs/release-trust.md#how-releases-are-verified).

## Installer tests

`test/e2e/app.ts` starts the real application with a throwaway profile, attaches
Playwright to its WebView2 over the DevTools protocol and works through the window;
`panes.ts`, `ipc.ts` and `windows.ts` are its hands in the panes, in the IPC
contract and in what Windows says about the windows. The installer tests build on it.

`install.vm.ts` (`npm run test:e2e:vm`) installs the two test installers of
`npm run build:test-installers` (this checkout's release build with a test key and a
local update feed) and checks a clean install, uninstalling with and without the data,
upgrading the previous published release with a profile in place, and the updater
installing from the local feed, for the installed and the portable copy, including
updates that are damaged or fail. Installing changes the account that runs the tests,
so they run only on a throwaway machine with `FTPEACH_DISPOSABLE_VM=1`, or in CI
(`installer.yml`). The profile they put in place connects to the OpenSSH server of
`scripts/test-servers/openssh.ps1 install`, after `iis.ps1 install`, whose account it
uses; both need an elevated PowerShell. A failed test keeps a trace, a screenshot and
the application's log under `test-results/e2e/`.

## Choosing the runtime

- Use `unit/` for pure functions, models and services with injected collaborators.
  These tests import `node:test` and `node:assert/strict`; they do not need a DOM.
  `unit/application/vaultAutoLock.test.ts` demonstrates injected event and timer
  targets. Pane service tests use `unit/helpers/paneClient.ts`, which wraps fake
  IPC with the production API adapters.
- Use `component/` for React rendering, hook effect lifetimes, DOM events and
  Vitest mocks. Import test functions from `vitest` and render through Testing
  Library. The setup in `component/helpers/setup.ts` cleans up rendered trees and
  `window.api` after each test. Restore any other global state a suite changes.
- Use `visual/` for real layout, text wrapping and screenshot comparisons.
  jsdom cannot validate browser geometry or rendering.

The Node and Vitest globs are scoped to separate directories, so a component
file ending in `.test.ts` cannot accidentally run under Node. Keep support files
free of `.test` or `.spec` suffixes. Static test data belongs in `fixtures/`.

## Coverage ownership

Pane navigation, file operations and session lifecycle belong to
`unit/file-browser/`; their factories accept injected collaborators.
`component/shared/dragHooks.test.tsx` owns gesture events, direction, geometry,
resize limits and unmount cleanup. Pure resize state transitions stay in
`unit/application/sectionResizeReducer.test.ts`.

Overlay dismissal, overflow folding, tooltips and truncation need the component
runtime. Their browser-only geometry and wrapping behavior belongs to visual
tests. Avoid recreating DOM behavior in a second Node harness.

Cross-feature helper checks are named `application/featureHelpers.test.ts` and
`application/workspaceModels.test.ts`. New feature-specific cases should go in
the corresponding feature directory. Keep regression cases and their shared
harness together rather than splitting a suite solely because it is long.

## Visual snapshots and updater fixtures

`visual/main.tsx` renders the production application against `visual/visualTestApi.ts`.
Snapshots in `visual/*.spec.ts-snapshots/` are Windows baselines, matching CI. Run `npm run test:visual:update` only after an intentional UI change, and inspect
the resulting images before committing them.

The harness accepts `?lang=<code>`. RTL scenarios wait for the application's
language setting to update `dir`; they do not force it independently.

Updater fixture contents and usage are documented in `fixtures/updater/README.md`.
Those keys and artifacts are for tests only.
