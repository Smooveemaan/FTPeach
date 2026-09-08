# Contributing

Open an issue before making a large change. Do not disclose vulnerabilities publicly; follow [SECURITY.md](SECURITY.md).

Follow the [development setup](README.md#development) for prerequisites, dependency installation, and the verified libsodium wrapper commands. Keep pull requests focused and add regression tests for behavior changes. Never commit credentials, private keys, server URLs, or user JSON/vault files.

## Pull request checks

```powershell
npm run check
```

A pull request should explain the problem, solution, tests, and manual verification. Include screenshots for UI changes and describe protocol fixtures without credentials. Architectural boundaries are documented in `docs/architecture.md` and `docs/frontend-architecture.md`. New IPC capabilities, secrets, paths, and remote names require a security review.

## Comments and API documentation

Ordinary comments should explain only a non-obvious current invariant, limitation, or design reason. Do not preserve migration history or descriptions of removed implementations in source code; Git history and `docs/` are the appropriate places for that information.

Document public Rust items with `///`. Use rustdoc links for available structures, traits, and functions, such as `[Store]` and [`Store::apply_layout`]. In React and TypeScript, use JSDoc (`/** ... */`) and links such as `{@link Application}` or `{@link normalizeCommandError}`. Single-line `//` comments do not replace public API documentation.
