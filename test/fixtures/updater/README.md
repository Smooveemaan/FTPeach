# Updater signing fixtures — dev-only key

`spike.key.pub` and the committed fixture signature come from a throwaway
minisign keypair generated for local testing (see `server.cjs`,
`dummy-update.bin(.sig)`, `latest.json`). The private `spike.key` is deliberately
not present in the current tree. Earlier development commits contained this
throwaway private key; treat it as public, including when reusing these fixtures.

These fixtures back two automated gates:

- `npm run test:updater-fixtures` verifies that the valid artifact passes
  signature verification and a damaged copy fails;
- `npm run check:release-config` asserts that the production
  `plugins.updater.pubkey` differs from this throwaway public key.

**This keypair is NOT valid for production.** It was previously also wired up
as `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`; the production
keypair is generated separately and its private half is never committed. Do
not point the production configuration at `spike.key.pub`.

To create a new local throwaway keypair, run from the repository root:

```powershell
npm.cmd exec tauri signer generate -- --write-keys test/fixtures/updater/spike.key
```

`spike.key` is ignored by Git. Re-sign the fixture and update `spike.key.pub`
only when intentionally replacing the updater fixtures. Never use this
keypair for a production release.

`server.cjs` serves `latest.json` as a local updater feed for manual
end-to-end checks of the update flow without touching GitHub.
