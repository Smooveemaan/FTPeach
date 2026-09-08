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
    platform/            Interface scale and Tauri adapter tests
    shared/              Dialogs, menus, drag and resize hooks
    helpers/             Global setup and Tauri test adapter
  visual/                Playwright scenarios, browser harness and snapshots
  fixtures/updater/      Signed sample update and local fixture server
```

## Commands

| Command | Scope |
| --- | --- |
| `npm test` | Unit tests, then component tests |
| `npm run test:unit` | `test/unit/**/*.test.ts`, using `node:test` |
| `npm run test:components` | `test/component/**/*.test.{ts,tsx}`, using Vitest |
| `npm run test:visual` | Browser scenarios in `test/visual/` |
| `npm run test:updater-fixtures` | Accept the valid update signature and reject a damaged artifact |
| `npm run rust:test` | Native Rust tests under `src-tauri/` |

Run one suite while working on a feature:

```sh
node --experimental-strip-types --test test/unit/file-browser/paneNavigation.test.ts
npm run test:components -- test/component/sites/siteManager.test.tsx
```

`npm run check` includes the project checks and test runners. The
`check:suite-coverage` command checks that its npm steps stay aligned with CI.
Packaged application smoke tests remain a separate CI-owned check.

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
Snapshots in `visual/application.spec.ts-snapshots/` are Windows baselines, matching
CI. Run `npm run test:visual:update` only after an intentional UI change, and inspect
the resulting images before committing them.

The harness accepts `?lang=<code>`. RTL scenarios wait for the application's
language setting to update `dir`; they do not force it independently.

Updater fixture contents and usage are documented in `fixtures/updater/README.md`.
Those keys and artifacts are for tests only.
