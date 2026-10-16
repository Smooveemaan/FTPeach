# Packaged native smoke

Run from the repository root on Windows with WebView2 and the pinned Rust toolchain:

```powershell
npm run build:packaged-smoke
npm run test:packaged-smoke
```

The build helper prepares verified libsodium and builds the smoke feature into .tools/smoke-target/debug/app.exe using dist assets. The harness launches that executable with isolated APPDATA/LOCALAPPDATA, waits up to 30 seconds for its result and successful process exit, then removes the temporary data. TAURI_DRIVER_DEBUG=1 exposes process output.

A second run copies the executable into a folder of its own with the `FTPeach.portable` marker. It passes only if `settings.json`, `tabs.json`, `local` and `webview` end up in `data` beside that copy and the isolated profile is still empty. The harness also compares FTPeach-named entries in the real APPDATA and LOCALAPPDATA
folders before and after the portable run, because Windows' known-folder API ignores
the isolated environment. Added entries or changes to recorded file sizes/timestamps
fail the run. This is a filesystem trace check, not proof that the registry or every
Windows subsystem is unchanged; those checks are in the
[release matrix](../../docs/release-trust.md#release-matrix).

The final UI steps add a tab and change pane orientation, then call the test-only
finish command without reloading the WebView or waiting for persistence debounce.
The shared shutdown must receive a successful renderer flush acknowledgement; the
fixture rereads tabs.json/settings.json to verify both last changes reached disk.

The harness uses no WebDriver, tauri-driver, msedgedriver or webdriverio. commands/smoke.rs and assets/smoke_test.js exercise backend settings/vault/basic local-copy checks, rendered panes, settings and bookmark dialogs, contrast and RTL geometry. Before exiting, it creates an edited Open with copy and runs the real `shutdown::wind_down` shared by quit and immediate update installation, then verifies the recovery payload and locked vault. This is a real WebView2 process with a test-only command; it does not validate every production capability, an installer, native drag, Explorer integration, Windows Hello/TPM or a production updater installation. See the [release matrix](../../docs/release-trust.md#release-matrix).
