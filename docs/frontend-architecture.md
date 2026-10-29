# Frontend architecture

`src/App.tsx` mounts `app/Application.tsx`, the composition root. User-facing state and lifecycle live in
`src/features`, application orchestration in `src/app`, reusable visual primitives in
`src/components`, and IPC in `src/platform`.

## Current map

Theme changes use `WebviewWindow.setBackgroundColor` to update both the host window
and WebView2's default background with an opaque color. Updating only `Window` leaves
the webview background at its startup color.

Mode (`theme`) and palette (`colorScheme`) are independent settings. `shared/appearance.ts`
applies their root attributes; `styles/palettes.css` owns their colors. Community palette
sources and adaptation details live in [asset provenance](legal/ASSET_PROVENANCE.md);
their licenses ship in `docs/legal/THIRD_PARTY_NOTICES.txt`. `windowFrame.ts`
reads the resolved panel background and sends a typed appearance snapshot through the
existing `app_set_window_border` command. The runtime keeps it for new security confirmations
and updates existing ones, including unsaved previews and cancellation. Confirmations
receive the initial snapshot before their scripts load and refresh it before showing;
they need no additional IPC permissions.

Viewport constraints use CSS viewport units in `foundation.css`; resizing does not
write pixel dimensions back into inherited root custom properties from JavaScript.

- `app/` composes dialogs, commands, bootstrap and status UI. `Application` wires feature
  facades and renders the shell; `useApplicationMenuCommands` registers the global shortcuts and
  builds the menu bar from one command context defined in `menus.ts`. `applicationWorkspaceModel`
  maps pane, transfer, log and layout state to the explicit `Workspace` view contract;
  `applicationDialogsModel` does the same for dialogs and owns
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
  `components/useDragMove` own pane controls and file-drag payloads. `FileBrowserPane` receives
  the `usePanes` and `useFileClipboard` models whole, the site lists, the layout settings and a
  small shell for what only `app/` owns (its dialogs, transfers, "Open with" and the error
  banner); `usePaneActions` holds the per-pane decisions: the context menu, reconnecting through
  the bookmark, opening local files, OS drops, going home, Move to and the drive menu;
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
  `useOverwriteApproval` (single-target and batch destination checks, including type conflicts,
  skip policy and serialized confirmations),
  `createTransferRouting` (recursive operations, pane copies/moves and OS drops), and the queue
  summary. Its public copy, drop and same-pane move operations own approval before execution;
  callers supply the selection and refresh callbacks, not an overwrite approval flag.
  Folder merges require their own explicit consent, separate from sibling file replacements.
  Local file copies use lifecycle rows as well; their native copy command has no pause or
  cancellation support. File operation and connection errors use the shell's dismissible
  error banner. Same-pane
  Move to uses native rename. Skipped batch names remain in the result so a partially moved cut
  stays on the clipboard. `TransferQueue` owns queue layout and scrolling; `components/TransferItemRow` renders
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
- `src/` itself holds `App.tsx` and `main.tsx` and nothing else; every other module belongs to
  a feature, to a shared layer or to `app/`.

## Import rules

- `app` composes features and shared UI; it may import feature public APIs.
- `features/<name>` owns the state and lifecycle for one user-facing capability.
- A feature may import from `shared`, `components`, `hooks`, `shortcuts`, `i18n` and platform APIs.
- A feature must not import another feature's internal files. Cross-feature use goes through a
  small public entrypoint when such a dependency becomes necessary. Use `index.ts` for headless
  APIs and an optional `ui.ts` when exporting JSX would make the headless API unusable from Node.
- Nothing outside `app/` may import from it — `app` is the composition root, so `features`,
  `shared`, `components`, and `platform` must not depend back on it. The exception is
  `App.tsx`, which sits above `app/` and mounts `app/Application.tsx`.
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

Adding a setting starts in `shared/settingsDefaults.json`, the defaults read by both Rust
and the renderer. Update the store's validation, the IPC contract, the owning settings group
and its consumer or dialog section as needed; `shared/settingsDefaults.ts` only exports the JSON.

## Global channels

Preferences that every row reads have an explicit owner rather than an ambient global:

- **Date format.** `features/settings/dateFormat.ts` owns the preference. `createDateFormatter`
  is pure, so a formatter can be built and asserted with no ambient state to reset;
  `useDateFormatter()` subscribes the components that render timestamps.
- **Interface scale.** `platform/interfaceScale.ts` sends the user preference to
  `app_set_interface_scale`. Layout coordinates stay in CSS pixels (`--interface-scale`
  remains 1). On Windows, `runtime/window_scale.rs` fixes WebView2 rasterization at 1
  and applies monitor DPI times the user factor through page zoom. Native DPI-change
  events reapply the latest in-memory preference; other platforms use ordinary page zoom.

`shared/asyncFailure.ts` keeps a module-level failure sink; the reason is written
at the top of that file.

## Boundary check

Avoid compatibility barrel files unless they form an intentional public API.

`npm run lint` also runs `scripts/checks/check-feature-boundaries.ts`. The check rejects cross-feature
internal imports and dependency cycles, so these boundaries remain enforceable as features evolve.
It parses TypeScript syntax, including side-effect imports, dynamic literal imports and inline
type imports. Relative extensionless and directory imports participate in cycle detection.
Only a feature's top-level `index.ts` or `ui.ts` is public; a nested `index.ts` remains internal.
TypeScript files under unrecognized source areas are rejected instead of bypassing the rules.

The cycle detector contracts the whole file import graph down to features rather than reading only
direct feature-to-feature edges. A dependency that passes through an unowned file — `a` imports
`shared/x.ts`, which imports `b` — is still an edge from `a` to `b`.

## Where a feature's other files live

A feature is not self-contained: its styles are in `src/styles/**`, its strings are namespaces in
`src/i18n/locales/*.json`, and its tests are grouped by area under `test/unit/` and
`test/component/`. Browser scenarios and snapshots live in `test/visual/`. The CSS cascade
needs one ordered entrypoint, every language needs its own file, and tests need
different runtime environments. See `test/README.md` for the test layout and commands.

| Feature | Locale namespaces | Stylesheets |
| --- | --- | --- |
| `features/file-browser` | `filePane`, `tabStrip`, `paneToolbar`, `paneSourceSwitcher`, `paneConnectEmptyState`, `paneMenu`, `paneSide`, `saveLocalPath` | `workspace/panes.css`, `workspace/tabs.css`, `workspace/controls.css` |
| `features/transfers` | `transfers`, `transferQueue` | `workspace/transfers.css` |
| `features/sites` | `siteManager`, `siteManagerDialog` | `dialogs/site-manager.css`, `dialogs/site-manager-modal.css` |
| `features/settings` | `settings` | `dialogs/settings.css`, `dialogs/settings-shell.css`, `dialogs/settings-fields.css` |
| `features/connections` | `connectionBar`, `protocolSelect` | `connection.css` |
| `features/logs` | `log`, `logPanel` | `panels.css` (log additions) |
| `features/open-with` | `openWithDialog`, `openWithChanged`, `recoveredEdits` | `dialogs/open-with.css` |
| `features/updater` | `update` | `panels.css` (banner) |
| `app/` | `menu`, `tray`, `quitDialog`, `statusBar`, `titleBar`, `viewToolbar`, `confirm`, `chmodDialog`, `newFolder`, `newFile`, `moveToDialog`, `saveSite`, `resize`, `dragMove`, `legacyPasswordNotice`, `plaintextSecretNotice`, `secretNotPersistedNotice` | `shell.css`, `workspace/controls.css` |
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

- `foundation.css` contains geometry tokens, reset, focus, and scrollbar defaults;
- `palettes.css` contains the shared color tokens and light/dark palette variants;
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
`npm run test:visual`. The deterministic browser harness at `test/visual/visual.html` renders the real
`Application` against `test/visual/visualTestApi.ts`; `npm run test:visual:update` is reserved for
intentional, reviewed UI changes.

Menu items share hover and keyboard-focus backgrounds in `styles/dialogs/menus.css`.
`SelectMenu` and `MenuItems` move DOM focus; the focused item is distinct from the
selected value. Menu focus uses `:focus-visible` independently of the global
Tab-only outline mode. `test/visual/keyboard-navigation.spec.ts` checks this behavior.

Transfer badges, connection indicators and status-bar states use shared `--status-*`
tokens. Readable text and saturated, borderless progress fills have separate values.
Connection dots retain a contrasting inset edge in light mode. Semantic hues depend on
light/dark mode, not the decorative palette accent. Separate `--log-*` tokens keep commands
orange and responses green across palettes. Errors retain the original red in both modes.
Connecting uses yellow throughout; the disconnected Connect button and pane dot use red.

`focusMenuItem` prevents native focus recentering and reveals only the hidden edge
of a row in its nearest menu scroller. Scrollable select menus keep their padding
outside the scrolling content so keyboard highlights never touch the frame.

## Local paths in the cross-platform build

The renderer reads the host OS from the WebView user agent in `src/platform/os.ts`.
Local navigation, breadcrumbs, tab names and transfer labels use Windows separators
and drive/UNC roots on Windows, and `/` on macOS and Linux. Remote paths always
use `/`; a backslash in a Unix filename remains part of its name.

Local path comparisons ignore case on Windows and preserve case on macOS and
Linux. The root menu selects the longest matching root on a segment boundary,
so a home directory takes precedence over `/`. This is an OS-level comparison,
not a probe of each volume's case sensitivity. The default drag action identifies
Windows volumes by drive letter or UNC share; Unix mount boundaries are not
queried, so Shift and Ctrl remain the explicit move and copy choices.

Download prechecks and the backend apply Windows device-name and character
restrictions only on Windows; Unix filesystem operations enforce their own naming
rules. These behaviors are covered by the local-path component tests and the
backend download-name tests. This is development behavior for the forthcoming
macOS/Linux builds; the published guide continues to describe the released app.
