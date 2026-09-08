# Frontend architecture

`src/App.tsx` mounts `app/Application.tsx`, the composition root. User-facing state and lifecycle live in
`src/features`, application orchestration in `src/app`, reusable visual primitives in
`src/components`, and IPC in `src/platform`.

## Current map

- `app/` composes dialogs, commands, bootstrap and status UI. `Application` wires feature
  facades and renders the shell; `useApplicationMenuCommands` owns the global keyboard/menu
  command surface. `applicationWorkspaceModel` maps pane, transfer, log and layout state to the
  explicit `Workspace` view contract; `applicationDialogsModel` does the same for dialogs and owns
  their cross-feature workflows such as diagnostics export, file-mode changes and application
  associations. `app/layout/` owns workspace geometry, section resize state and persistence;
  `TitleBar` and `ViewToolbar` belong to the application shell;
- `features/file-browser/` owns panes, navigation, selection and file operations. `FilePane`
  composes the pane shell and list, while dedicated hooks own sorting and pane-level keyboard
  commands; `FileColumnHeader` owns sortable, resizable and reorderable column UI. At the workspace
  level, `usePanes` is the public facade: pane refresh request arbitration, runtime subscriptions,
  recent-site state, session persistence, and the memoized connection view model live in focused
  modules under `panes/`. Persistence serialization is dependency-free and intentionally excludes
  connection state, directory entries and credentials. `components/PaneToolbar` and
  `components/useDragMove` own pane controls and file-drag payloads;
- `features/sites/` owns saved-site editing, tree layout and drag/drop. `SiteManagerDialog` composes
  the UI, while dedicated hooks own secret lifetime, search state, persistence mutations and drag
  behavior; secret values stay in DOM refs and never enter React form state. `SiteTree` composes
  tree data and drag/drop orchestration, `components/SiteTreeRows` owns row and overlay rendering,
  and `useSiteTreeNavigation` owns roving focus and keyboard commands over the dependency-free
  ordering model in `siteDragModel`. `siteSearchModel` builds normalized search text once per
  site snapshot; `useSiteSearch` owns query and focus state. Sortable contexts disable reordering
  in automatic sort modes while the sensor list remains stable;
- `features/transfers/` owns queue state, progress and notifications, `transferStore.ts`
  included — file-browser reads the snapshot through `features/transfers/index.ts` rather than
  the store being pushed down into `shared/` to make that import legal. Its lifecycle hook owns
  individual jobs and queue commands. `useTransfers` composes that lifecycle with
  `useOverwriteApproval` (destination checks and serialized confirmations),
  `createTransferRouting` (recursive operations, pane copies/moves and OS drops), and the queue
  summary. `TransferQueue` owns queue layout and scrolling; `components/TransferItemRow` renders
  one transfer; `transferColumns` and `transferPresentation` define column and label contracts;
- `features/settings/`, `logs/`, `open-with/`, `connections/`, `updater/` own their workflows;
- `components/` contains reusable leaf UI without feature-specific state or feature imports;
- `hooks/` contains reusable UI mechanics: overlays, measurements, column dragging and generic
  drag sessions. Workspace persistence and file-drag payloads belong to their domain owners;
- `shared/layoutMetrics.ts` defines panel header dimensions used by both layout and panel views;
- `features/logs/logBuffer.ts` owns bounded retention independently of React and IPC;
  `useLogLines` owns subscription lifetime and allocates IDs outside replayable state updaters;
- `platform/api/` exposes typed domain wrappers; `tauriApi.ts` is the invoke/listen adapter.
  `platform/useWindowControls` owns native window commands and resize subscriptions, including
  disposal when asynchronous registration finishes after unmount;
- `i18n/` and `styles/` are shared localization and cascade entrypoints;
- `src/` itself holds `App.tsx` and `main.tsx` and nothing else. What used to live beside
  them was two levels at once: `utils.ts` sat below the features that all imported it, while
  `menus.ts` imported two of them and sat above. Its contents went to their owners —
  `SITE_*`/`siteMeta` to sites, `isTransferNameConflict` to transfers, `remoteCrumbs` and
  `parentRemotePath` to file-browser, the formatters and path joins to `shared/` — and
  `menus.ts` and `vaultAutoLock.ts` to `app/`, which is the level they were already at.

## Import rules

- `app` composes features and shared UI; it may import feature public APIs.
- `features/<name>` owns the state and lifecycle for one user-facing capability.
- A feature may import from `shared`, `components`, `hooks`, `shortcuts`, `i18n` and platform APIs.
- A feature must not import another feature's internal files. Cross-feature use goes through a
  small public entrypoint when such a dependency becomes necessary. Use `index.ts` for headless
  APIs and an optional `ui.ts` when exporting JSX would make the headless API unusable from Node.
- Nothing outside `app/` may import from it — `app` is the composition root, so `features`,
  `shared`, `components`, and `platform` must not depend back on it. The one exception is
  `App.tsx`, the file `app/*` was decomposed out of, which still imports every `app/*` module.
- `shared`, `platform`, `components`, `hooks`, `shortcuts` and `i18n` must not import from
  `features`, even through public entrypoints. These areas sit below features in the graph.
- Platform IPC remains behind `src/platform`; feature hooks accept an API override when that
  makes lifecycle behavior independently testable. Direct `@tauri-apps/api` imports outside
  `src/platform` are rejected without per-component exceptions.
- IPC is reached by importing `api` from `platform/api/index.ts`, never by reading the
  `window.api` global. The global still exists — `platform/tauriApi.ts` installs it at startup,
  and only inside Tauri — but naming it outside `src/platform` and `src/app` is rejected,
  because a global dependency leaves no import edge for the boundary check or a reader to see.
- Presentational components take the API slice they use as a prop rather than importing one:
  `AboutDialog` takes `appApi`, `VaultUnlockDialog` takes `vaultApi`, and the settings
  sections take the native pickers they open. A component that renders is testable without a
  backend; a component that calls IPC is not.

## Settings

`useSettings` holds the settings grouped by owner — `interface`, `layout`, `connection`,
`transfers`, `updates`, `security`, `logging`, `shortcuts` — and returns one updater per group.
A consumer takes the group it is about: `useWorkspaceLayout` takes `layout` and `logging`,
`useAppEffects` takes `interface`. The groups are the settings dialog's own sections plus
`layout` for the persisted geometry the dialog never shows.

The persisted format is unchanged and stays flat: `SettingsValues` is one field per stored key,
which is what the backend stores and what a settings patch names. `settingsValues(state)` flattens
the groups for the settings dialog, which shows them all.

Before this, the state was one flat object of ~45 fields and so was every consumer:
`Application.tsx` destructured 45 names by hand to hand them on in ones and twos, and adding a
setting meant editing six files in two languages. It still means editing the Rust store, the IPC
type and `shared/settingsDefaults.ts`; on the renderer side it is now one group and its consumer.

## Global channels

Three pieces of state used to travel outside both props and imports. Two are gone:

- **Date format.** `features/settings/dateFormat.ts` owns the preference. `createDateFormatter`
  is pure, so a formatter can be built and asserted with no ambient state to reset;
  `useDateFormatter()` subscribes the components that render timestamps. This replaced a mutable
  `let` in the former `src/utils.ts` plus a `ftpeach:date-format-changed` DOM event that one component
  listened for and turned into a forced re-render of every row.
- **Interface scale.** `platform/interfaceScale.ts` owns both halves — `applyInterfaceScale`
  writes the `--interface-scale` custom property, `getInterfaceScale` reads it. The reader used
  to live in a separate `src/utils/` file, which hid that the two are one contract.

The third, `shared/asyncFailure.ts`'s failure sink, stays global on purpose; the reason is
written at the top of that file.

## Migration order

Move one independently testable feature at a time, keep `App.tsx` as the composition root, and
run tests, lint, formatting, and a production build after every step. Avoid compatibility barrel
files unless they form an intentional public API.

`npm run lint` also runs `scripts/checks/check-feature-boundaries.ts`. The check rejects cross-feature
internal imports and dependency cycles, so these boundaries remain enforceable as features evolve.
It parses TypeScript syntax, including side-effect imports, dynamic literal imports and inline
type imports. Relative extensionless and directory imports participate in cycle detection.
Only a feature's top-level `index.ts` or `ui.ts` is public; a nested `index.ts` remains internal.
TypeScript files under unrecognized source areas are rejected instead of bypassing the rules.

The cycle detector contracts the whole file import graph down to features rather than reading only
direct feature-to-feature edges. A dependency that passes through an unowned file — `a` imports
`shared/x.ts`, which imports `b` — is still an edge from `a` to `b`, and a cycle built out of
such hops was previously invisible.


## Where a feature's other files live

A feature is not self-contained: its styles are in `src/styles/**`, its strings are namespaces in
`src/i18n/locales/*.json`, and its tests are grouped by area under `test/unit/` and
`test/component/`. Browser scenarios and snapshots live in `test/visual/`. The CSS cascade
needs one ordered entrypoint, the DeepL sync needs one file per language, and tests need
different runtime environments. See `test/README.md` for the test layout and commands.

| Feature | Locale namespaces | Stylesheets |
| --- | --- | --- |
| `features/file-browser` | `filePane`, `tabStrip`, `paneToolbar`, `paneSourceSwitcher`, `paneConnectEmptyState`, `paneMenu`, `paneSide`, `saveLocalPath` | `workspace/panes.css`, `workspace/tabs.css`, `workspace/controls.css` |
| `features/transfers` | `transfers`, `transferQueue` | `workspace/transfers.css` |
| `features/sites` | `siteManager`, `siteManagerDialog` | `dialogs/site-manager.css`, `dialogs/site-manager-modal.css` |
| `features/settings` | `settings` | `dialogs/settings.css`, `dialogs/settings-shell.css`, `dialogs/settings-fields.css` |
| `features/connections` | `connectionBar`, `protocolSelect` | `connection.css` |
| `features/logs` | `log`, `logPanel` | `panels.css` (log additions) |
| `features/open-with` | `openWithDialog`, `openWithChanged` | `dialogs/open-with.css` |
| `features/updater` | `update` | `panels.css` (banner) |
| `app/` | `menu`, `tray`, `statusBar`, `titleBar`, `viewToolbar`, `confirm`, `chmodDialog`, `newFolder`, `newFile`, `moveToDialog`, `saveSite`, `resize`, `dragMove`, `legacyPasswordNotice`, `plaintextSecretNotice`, `secretNotPersistedNotice` | `shell.css`, `workspace/controls.css` |
| `components/` | `promptDialog`, `exportSettingsDialog`, `importSettingsDialog`, `aboutDialog`, `toolbarOverflowMenu`, `errorBoundary` | `dialogs/modal.css`, `dialogs/about.css`, `dialogs/menus.css`, `dialogs/move-to.css`, `dialogs/error-boundary.css`, `workspace/controls.css`, `workspace/status.css` |
| `platform/` | `securityConfirmation` | `security-confirmation.css` |
| `shared/` | `errors`, and `common` — the only namespace every zone reads | `foundation.css` |

Two namespaces are read outside their owner on purpose: `common` everywhere, and `settings` from
`components/ShortcutRecorder.tsx`, `components/VaultUnlockDialog.tsx`, `shortcuts/registry.ts` and
`shared/errorMessages.ts`, which name settings the user recognizes from that dialog.

Nothing enforces this table — a locale namespace is a string key and a stylesheet is imported by
`theme.css`, not by the component. Keep it current when a feature gains or loses either.

## CSS organization

`src/styles/theme.css` is the ordered stylesheet entrypoint. Its imports preserve cascade order and
have the following ownership:

- `foundation.css` contains design tokens, theme overrides, reset, focus, and scrollbar defaults;
- `shell.css` contains the application and title-bar shell;
- `connection.css` contains connection forms and shared button primitives;
- `workspace.css` is a cascade-order facade; `styles/workspace/` assigns tabs/toolbars, panes/file
  lists, transfers, status, and the remaining shared workspace controls to separate files;
- `dialogs.css` is a cascade-order facade; `styles/dialogs/` separates Site Manager, menus, modal
  primitives, About, Settings, Open With, Move To, and the error boundary by component ownership;
- `panels.css` contains search state, transfer/log additions, and shared tooltip UI.

New class names use kebab-case and a component or feature prefix, for example
`transfer-progress-label` or `site-manager-toolbar`. State modifiers use `is-*`/`has-*` when a new
name is introduced. Keep selectors below a feature's root class where practical, do not use DOM ids
for styling, and add a foundation-level utility only when it is intentionally shared by multiple
features. Theme-specific values belong in tokens rather than duplicated component selectors.

The facade import order is a compatibility contract. Do not reorder imports as part of a file move:
first update or add a visual baseline, then make the smallest ownership change and run
`npm run test:visual`. The deterministic browser harness at `visual.html` renders the real
`Application` against `test/visual/visualTestApi.ts`; `npm run test:visual:update` is reserved for
intentional, reviewed UI changes.
