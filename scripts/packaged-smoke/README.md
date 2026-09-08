# Packaged native smoke

Run from the repository root on Windows with WebView2 and the pinned Rust toolchain:

```powershell
npm run build:packaged-smoke
npm run test:packaged-smoke
```

The build helper prepares verified libsodium and builds the smoke feature into .tools/smoke-target/debug/app.exe using dist assets. The harness launches that executable with isolated APPDATA/LOCALAPPDATA, waits up to 30 seconds for its result and successful process exit, then removes the temporary data. TAURI_DRIVER_DEBUG=1 exposes process output.

The harness uses no WebDriver, tauri-driver, msedgedriver or webdriverio. commands/smoke.rs and assets/smoke_test.js exercise backend settings/vault/basic local-copy checks, rendered panes, settings and bookmark dialogs, contrast and RTL geometry. This is a real WebView2 process with a test-only command; it does not validate every production capability, an installer, native drag, Explorer integration, Windows Hello/TPM or a production updater installation. See [native validation](../../docs/native-validation.md).
