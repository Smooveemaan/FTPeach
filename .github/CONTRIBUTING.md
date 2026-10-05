# Contributing

Open an issue before making a large change. Do not disclose vulnerabilities publicly; follow [SECURITY.md](SECURITY.md).

Follow the [development setup](../README.md#development) for prerequisites, dependency installation, and the verified libsodium wrapper commands. Keep pull requests focused and add regression tests for behavior changes. Never commit credentials, private keys, server URLs, or user JSON/vault files.

## Pull request checks

```powershell
npm run check
```

A change is done when:

1. **The behavior is tested.** A behavior change or bug fix comes with a test that fails without it, in the suite that owns the area ([test/README.md](../test/README.md); Rust tests sit next to their module).
2. **The documents say what the code now does.** Update the page that describes the behavior in the same change: the [user guide](../docs/user-guide.md) for what users see, the matching page in [docs/](../docs/README.md) for design and limits. Remove statements that stopped being true. Give each fact one home and link to it rather than repeating it.
3. **Users are told.** A change users will notice gets one line under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md): one short sentence about what they see, without protocol commands, internal terms or backstory. Released sections are not edited.
4. **Every exception is explained.** When the documents or the changelog need no change, the commit message says why, one trailer each. `npm run check:docs-impact` requires this for code linked to a document in `scripts/checks/check-doc-impact.ts`, and for any change to the app itself:

   ```text
   Docs-Impact: none - internal refactor, behavior unchanged
   Changelog: none - tests only
   ```

   A fix that restores behavior the guide already describes needs no guide change, but usually still deserves a changelog line.

The [user guide](../docs/user-guide.md) states only behavior that something checks. Each statement carries a hidden marker, `<!-- verified-by: <gate> <file>::<test name> -->`: `pr` for tests that block every change, `weekly` for the ignored Docker suites run on a schedule, `manual` for a run recorded in [manual checks](../docs/manual-checks.md). `npm run check:verified-by` fails when a named test disappears, is switched off or runs somewhere other than the marker says. It cannot tell whether the test asserts what the sentence says; check that when writing the marker.

UI text is translated by hand, with the context of a file manager in mind; machine translation is not used. New text may ship in English and Russian first, with the English text standing in for the other locales until they are translated. `npm run i18n:audit` opens every screen, menu and dialog the test harness reaches in each language and in a pseudo-locale (English made longer and bracketed), and lists text that is cut off, overlaps or never went through a translation in `test-results/i18n-audit/summary.md`, with screenshots.

The website at <https://ftpeach.com/> is `site/index.html`. `npm run site:build` writes it to `dist-site/` with the latest release's version and download links, and `pages.yml` publishes it on a push and whenever a release is published, so a release needs no edit there. It shows `assets/images/ftpeach.png` in the dark theme and `ftpeach-light.png` in the light one; after a visible UI change retake both with `npm run screenshot:readme` and `npm run screenshot:readme -- --light`. Its link preview `assets/images/og.jpg` and the repository's social preview `github-social.jpg` are drawn by `npm run site:social` from the page's fonts and colours; redraw them after the headline or the icon changes, and upload the second one by hand in Settings > Social preview.

A pull request should explain the problem, solution, tests, and manual verification. Include screenshots for UI changes and describe protocol fixtures without credentials. Architectural boundaries are documented in `docs/architecture.md` and `docs/frontend-architecture.md`. New IPC capabilities, secrets, paths, and remote names require a security review.

## Comments and API documentation

Ordinary comments should explain only a non-obvious current invariant, limitation, or design reason. Do not preserve migration history or descriptions of removed implementations in source code; Git history and `docs/` are the appropriate places for that information.

Document public Rust items with `///`. Use rustdoc links for available structures, traits, and functions, such as `[Store]` and [`Store::apply_layout`]. In React and TypeScript, use JSDoc (`/** ... */`) and links such as `{@link Application}` or `{@link normalizeCommandError}`. Single-line `//` comments do not replace public API documentation.
