# Contributing

Bug reports, feature requests and translation problems are welcome as [issues](https://github.com/Smooveemaan/ftpeach/issues/new/choose). FTPeach does not accept pull requests: part of the tests every change has to pass are closed ([How releases are verified](../docs/release-trust.md#how-releases-are-verified)), so a pull request could not be checked here. Do not disclose vulnerabilities publicly; follow [SECURITY.md](SECURITY.md).

The rules below are how changes to FTPeach are made.

Follow the [development setup](../README.md#development) for prerequisites, dependency installation, and the verified libsodium wrapper commands. Keep changes focused and add regression tests for behavior changes. Never commit credentials, private keys, server URLs, or user JSON/vault files.

## Checks before a change

```powershell
npm run check
```

A change is done when:

1. **The behavior is tested.** A behavior change or bug fix comes with a test that fails without it, in the suite that owns the area ([test/README.md](../test/README.md); Rust tests sit next to their module).
2. **The documents say what the code now does.** Update the page that describes the behavior in the same change: the [user guide](../docs/guide/index.md) for what users see, the matching page in [docs/](../docs/README.md) for design and limits. Remove statements that stopped being true. Give each fact one home and link to it rather than repeating it.
3. **Users are told.** A change users will notice gets one line under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md): one short sentence about what they see, without protocol commands, internal terms or backstory. Released sections are not edited.
4. **Every exception is explained.** When the documents or the changelog need no change, the commit message says why, one trailer each. `npm run check:docs-impact` requires this for code linked to a document in `scripts/checks/check-doc-impact.ts`, and for any change to the app itself:

   ```text
   Docs-Impact: none - internal refactor, behavior unchanged
   Changelog: none - tests only
   ```

   A fix that restores behavior the guide already describes needs no guide change, but usually still deserves a changelog line.

The [user guide](../docs/guide/index.md) states only behavior that something checks. Each statement carries a hidden marker, `<!-- verified-by: <gate> <file>::<test name> -->`: `pr` for the ordinary non-ignored suites (CI selects Rust and visual jobs by changed paths) and `manual` for a run recorded in [manual checks](../docs/manual-checks.md). `npm run check:verified-by` checks every topic page in `docs/guide/` and confirms that the named test or manual heading exists and that the declared test category matches its source. It does not execute the test, inspect every workflow path filter or prove that the check asserts what the sentence says; review that when writing the marker.

UI text is translated by hand, with the context of a file manager in mind; machine translation is not used. New text may ship in English and Russian first, with the English text standing in for the other locales until they are translated. `npm run i18n:audit` opens every screen, menu and dialog the test harness reaches in each language and in a pseudo-locale (English made longer and bracketed), and lists text that is cut off, overlaps or never went through a translation in `test-results/i18n-audit/summary.md`, with screenshots. A problem not on its known list (`test/visual/i18nAuditSummary.ts`) fails the run; CI runs it in five languages when the interface changes and in every language weekly. A new screen or dialog gets a state in `test/visual/i18n-layout.audit.ts`, so the pseudo-locale reaches it too. The audit fails on a string of `en.json` that no state shows, unless `test/visual/i18nAuditUnshown.json` lists it with its prefix or by name.

The website at <https://ftpeach.com/> uses `site/index.html`, shared styles in `site/styles.css`, and local fonts in `site/fonts/`. The user guide is written once in `docs/guide/` and rendered with Marked into `dist-site/guide/`; the same Markdown is readable on GitHub. `scripts/site/guide.ts` lists the published pages and their descriptions, generates their navigation and sitemap, and maps links to other repository documents to GitHub. Add a page there when adding a guide topic. The old `docs/user-guide.md` keeps links to the moved sections. `npm run site:build` writes it to `dist-site/` with the latest release's version and download links, and `pages.yml` publishes it when site inputs change, whenever a release is published and daily to refresh public counts, so a release needs no edit there. It shows `assets/images/ftpeach-dark.png` in the dark theme and `ftpeach-light.png` in the light one; after a visible UI change both are retaken from the running application, never edited by hand. Its link preview `assets/images/og.jpg` and the repository's social preview `github-social.jpg` are drawn by `npm run site:social` from the page's fonts and colours; redraw them after the headline or the icon changes, and upload the second one by hand in Settings > Social preview.

Guide illustrations live in `site/images/guide/` and are copied into the website build. Retake them with the closed screenshot tool after changing the pictured controls: it captures the real application components with example data in the visual harness, without a native profile or live server. Inspect the images before committing; do not draw or retouch interface elements. Keep captions and alt text beside the task they illustrate, and link images to their full-size copies. The website enhances these links with a modal image viewer; direct image links remain the fallback without JavaScript.

Describe protocol fixtures without credentials. Architectural boundaries are documented in `docs/architecture.md` and `docs/frontend-architecture.md`. New IPC capabilities, secrets, paths, and remote names require a security review.

## Comments and API documentation

Ordinary comments should explain only a non-obvious current invariant, limitation, or design reason. Do not preserve migration history or descriptions of removed implementations in source code; Git history and `docs/` are the appropriate places for that information.

Document public Rust items with `///`. Use rustdoc links for available structures, traits, and functions, such as `[Store]` and [`Store::apply_layout`]. In React and TypeScript, use JSDoc (`/** ... */`) and links such as `{@link Application}` or `{@link normalizeCommandError}`. Single-line `//` comments do not replace public API documentation.
