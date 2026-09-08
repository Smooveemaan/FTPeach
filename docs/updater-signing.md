# Signing Tauri updates

Updater artifact signatures protect FTPeach updates from substitution. This is not Windows Authenticode: without a separate code-signing certificate, SmartScreen may still warn about an unknown publisher.

## Keys

`src-tauri/tauri.conf.json` contains only the public key. Never store the private key or its password in the repository, `.env`, release artifacts, or CI logs. Losing the private key prevents existing installations from accepting updates signed by a new pair, so keep a separate backup in secure storage.

If no private key matches the current `plugins.updater.pubkey`, generate a new production pair before the first public release:

```powershell
npm.cmd exec tauri signer generate -- --write-keys C:\secure\ftpeach-updater.key
```

The command creates a private file and a public file with a `.pub` suffix. Put the `.pub` contents in `plugins.updater.pubkey`; store the private file in a secret manager and separate secure backup. Keys under `test/fixtures/updater/` are test-only and must never sign releases.

## GitHub Actions

Create these secrets in the GitHub `release` environment:

- `TAURI_SIGNING_PRIVATE_KEY`: the complete production private-key contents;
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the key password.

Configure the environment with required reviewers and disallow administrator
bypass. Keep both signing secrets at environment scope, not repository or
organization scope. GitHub does not store deployment-protection rules in the
workflow file, so repository owners must preserve this setting separately.

The `.github/workflows/release.yml` workflow runs for `v*` tags only after the
frontend, Rust and packaged smoke gates pass. It builds the Windows NSIS
installer, creates its `.sig` and `latest.json`, verifies every signature with
the configured production public key, attaches npm and Cargo CycloneDX SBOMs,
and publishes a draft GitHub Release. Before publishing the draft, verify the
version, file list and URLs. Signature verification is already a blocking gate,
including a separate positive/negative fixture test.

Run a local signed build only in the current PowerShell session:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = 'C:\secure\ftpeach-updater.key'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '<password>'
npm.cmd run build:tauri
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

Do not pass the password as a command-line argument; it may be recorded in shell history or exposed in the process list.
