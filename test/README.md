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
  e2e/                   The real application driven through its window (CDP)
  fixtures/updater/      Signed sample update and local fixture server
```

## Commands

| Command | Scope |
| --- | --- |
| `npm test` | Unit tests, then component tests |
| `npm run test:unit` | `test/unit/**/*.test.ts`, using `node:test` |
| `npm run test:components` | `test/component/**/*.test.{ts,tsx}`, using Vitest |
| `npm run test:visual` | Browser scenarios in `test/visual/` |
| `npm run test:e2e` | The packaged smoke build driven through its window against a real server, see below |
| `npm run test:e2e:stand` | The same, on the file-system stand of `fs-stand.ps1`, see below |
| `npm run test:updater-fixtures` | Accept the valid update signature and reject a damaged artifact |
| `npm run rust:test` | Native Rust tests under `src-tauri/` |

Run one suite while working on a feature:

```sh
node --experimental-strip-types --test test/unit/file-browser/paneNavigation.test.ts
npm run test:components -- test/component/sites/siteManager.test.tsx
```

`npm run check` includes the project checks and test runners. The
`check:ci-parity` command checks that its npm steps stay aligned with CI; it does not
measure code coverage. `npm run coverage` runs both suites with coverage, see
[docs/coverage.md](../docs/coverage.md).
Packaged application smoke tests remain a separate CI-owned check.

## Desktop end-to-end tests

`test/e2e/` starts the real application (`npm run build:packaged-smoke` builds it;
it runs as the ordinary application) with a throwaway profile, attaches Playwright
to its WebView2 over the DevTools protocol and works through the window against a
real server. The result is judged outside the application: the tests read the
server's disk and the local disk and compare SHA-256 sums.

- `ftp.e2e.ts` covers an upload, a download, a name conflict cancelled and then
  overwritten, a folder with nested and empty folders, a rename and a Move to on
  the server, a cut refused when pasted across to the other side either way, a
  bookmark opening its folder with a listing that matches the
  server's disk name for name, a sign-in retried after a wrong password, Stop
  during an upload over an existing file, Pause and Resume of an
  upload, an upload the server refuses, and a file someone else stores under
  the name while it uploads, which stays. It expects IIS FTP from
  `scripts/test-servers/iis.ps1 install`, with its `fixtures/perms` folders, or a
  server named by the `FTPEACH_E2E_FTP_*` variables. IIS deletes an aborted upload
  itself, so these tests cannot see whether FTPeach removes its own staging file
  after Stop, and a paused upload always starts over there.
- `ftps.e2e.ts` checks that the IIS site's self-signed certificate is refused
  when nothing vouches for it, then uploads over FTPS from a bookmark saved with
  the certificate's CA (`cert.pem` from `iis.ps1`), put in the profile as a
  user would have saved it.
- `webdav.e2e.ts` runs a recording http:// server of its own to check that the
  password reaches it only once Allow unencrypted sign-in is ticked, then
  uploads and downloads over the IIS WebDAV site, stops an upload over an
  existing file there and keeps a file someone else stores under the name
  while it uploads.
- `sftp.e2e.ts` trusts the server's key in the security window, which must show
  the key's real fingerprint, then covers an upload, Stop with the staging file
  removed, Resume appending to the staging file the pause kept, and Resume
  after the source was edited starting over without leaving that file behind,
  a file someone else stores under the name while it uploads, then Retry once
  the name is free, Stop of a folder merge that keeps the file being replaced
  and a staging file that is not its own, Quit when transfers finish, called
  off and then let through, Stop of an upload waiting for the one connection
  allowed, one name uploaded from two tabs at once, a selection where some
  files copy, existing ones are skipped and unreadable ones fail, folders
  copied both ways at once between two connections to the server, one in
  each pane, while one transfer at a time is allowed, and a connection cut by a relay in the test: the pane says it is gone, and
  connecting it again lists and uploads. It expects
  OpenSSH from `scripts/test-servers/openssh.ps1 install` (after `iis.ps1 install`,
  whose account it uses), or a server named by the `FTPEACH_E2E_SFTP_*` variables.
  OpenSSH keeps a partly uploaded file, so what is left is FTPeach's doing.
- `local.e2e.ts` needs no server: a folder cut and pasted into a folder of the
  same name, where one file cannot be replaced, copies the rest and deletes
  none of its sources.
- `filesystem.e2e.ts` covers what NTFS does to file operations: junctions not
  entered or deleted, a copy that does not write through a hard link, a file
  another program holds, a folder the account may not add files to, names in a
  folder deeper than 260 characters, the Recycle Bin, a network path typed
  instead of chosen, FTPeach's own data folder, the Mark of the Web on an IIS
  FTP download, and names a WebDAV server of the test's own lists that Windows
  cannot hold.
- `profiles.e2e.ts` starts on each profile of `test/fixtures/profiles` (its
  README says what each holds): one without the schema envelope from before
  0.1.0 with a password in plain text, one with system protection as 0.1.0 to
  0.4.0 write it, and one with a master password. It judges settings,
  bookmarks, local paths, the session and the protection in the window, connects
  with the saved password, changes something and judges it after a restart.
- `portable.e2e.ts` runs portable copies (`test.use({ appPortable: true })`):
  a certificate and a log folder chosen inside the copy, found again after the
  folder moves and under two drive letters made with `subst`; the copy without
  its marker; the notification entry in the registry while it runs, at exit and
  after a crash; a data folder it cannot write, said before any window; and a
  second start, which brings back an installed copy hidden in the tray.
- `*.stand.ts` (`npm run test:e2e:stand`, not part of `npm run test:e2e`) needs
  the stand of `scripts/test-servers/fs-stand.ps1 install`: a small NTFS drive to
  move to and fill, an exFAT drive without a USN journal, two SMB shares (one
  read only, one the tests take away through two scheduled tasks) and symbolic
  links. The stand describes itself in `C:\ftpeach-test-servers\fs-stand.json`;
  a part of it that is missing fails the test.

All three scripts change the machine and need an elevated PowerShell. A missing server
fails the test. A test can start the application with its own settings and saved
store files through `test.use({ appSettings, appStore })`, or as a portable copy
with `appPortable`. A Choose folder… dialog and a key or certificate picker are
answered through `app.pick`. The application's
windows open off screen without taking the focus, and its notifications are
off, so a run leaves the desktop free to work at. For the same reason the test
build opens nothing outside FTPeach: a file with its default program or Windows'
Open with chooser, Explorer, a log folder or a web page is held back and logged,
and a test that set one off fails (a program a test associates itself, such as
the editor of `open-with.e2e.ts`, still starts). Bringing the window back from
the tray does not take the focus either, and a reason not to start that would
be a message box is written to the file `FTPEACH_E2E_MESSAGE_FILE` names. Close
FTPeach first:
the application is single-instance, so the tests run one at a time and never
beside a running copy. A failed test keeps a trace, a screenshot and the
application's log (`app.log`) under `test-results/e2e/`.

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
