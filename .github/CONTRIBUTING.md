# Contributing

Bug reports, feature requests and translation problems are welcome as [issues](https://github.com/Smooveemaan/ftpeach/issues/new/choose). FTPeach does not accept pull requests: the release verification includes closed test suites ([How releases are verified](../docs/release-trust.md#how-releases-are-verified)), so a pull request could not be checked here. Do not disclose vulnerabilities publicly; follow [SECURITY.md](SECURITY.md).

The rules below are how changes to FTPeach are made.

Follow the [development setup](../docs/development.md) for prerequisites, dependency installation, and the build commands. Keep changes focused and add regression tests for behavior changes. Never commit credentials, private keys, server URLs, or user JSON/vault files.

## Making a change

Work on `master`. Check the affected behavior locally, review the diff, then
commit and push; CI runs the general checks. `npm run check` is an optional full
local diagnostic, not a requirement before each commit or push.

Add a regression test for new logic or a behavior fix. Text, styling and moving
an unchanged control do not require a new test. Preserve security and data-loss
checks. Update the document whose described behavior changed and add a short
Unreleased changelog entry when users of the last release will notice the change.
No exemption trailers are required when docs or the changelog need no change.

CI tests may retry once. A retry-pass is recorded as flaky; a second failure needs
a fix. After a fix, repeat affected checks rather than every suite. Releases still
verify the final build and installer, public CI and the closed suites.

Deterministic tables between `<!-- generated:... -->` markers have a machine-readable source. After changing that source, run `npm run docs:generate`; do not edit the generated block by hand. `npm run check:docs` fails locally and in CI when the committed block is stale. Text outside the markers remains authored documentation.

The [user guide](../docs/guide/index.md) describes supported, verified behavior.
Optional `<!-- verified-by: <gate> <file>::<test name> -->` markers link to tests
(`pr`) or headings in [manual checks](../docs/manual-checks.md) (`manual`).
`npm run check:verified-by` validates existing links; it does not prove the prose.

UI text is translated by hand, with the context of a file manager in mind; machine translation is not used. New text may ship in English and Russian first, with the English text standing in for the other locales until they are translated. `npm run i18n:audit` opens every screen, menu and dialog the test harness reaches in each language and in a pseudo-locale (English made longer and bracketed), and lists text that is cut off, overlaps or never went through a translation in `test-results/i18n-audit/summary.md`, with screenshots. A problem not on its known list (`test/visual/i18nAuditSummary.ts`) fails the run; CI runs it in five languages when the interface changes and in every language weekly. A new screen or dialog gets a state in `test/visual/i18n-layout.audit.ts`, so the pseudo-locale reaches it too. The audit fails on a string of `en.json` that no state shows, unless `test/visual/i18nAuditUnshown.json` lists it with its prefix or by name.

The website at <https://ftpeach.com/> uses `site/index.html`, shared styles in `site/styles.css`, and local fonts in `site/fonts/`. The user guide is written once in `docs/guide/` and rendered with Marked into `dist-site/guide/`; the same Markdown is readable on GitHub. `scripts/site/guide.ts` lists the published pages and their descriptions, generates their navigation and sitemap, and maps links to other repository documents to GitHub. Add a page there when adding a guide topic. The old `docs/user-guide.md` keeps links to the moved sections. `npm run site:build` writes it to `dist-site/` with the latest release's version and download links, and `pages.yml` publishes it when site inputs change, whenever a release is published and daily to refresh public counts, so a release needs no edit there. It shows `assets/images/ftpeach-dark.png` in the dark theme and `ftpeach-light.png` in the light one; retake them from the running application when they noticeably differ from the interface, never edit them by hand. Its link preview `assets/images/og.jpg` and the repository's social preview `github-social.jpg` are drawn by `npm run site:social` from the page's fonts and colours; redraw them after the headline or the icon changes, and upload the second one by hand in Settings > Social preview.

Guide illustrations live in `site/images/guide/` and are copied into the website build. Retake them with the closed screenshot tool when the pictured controls noticeably differ: it captures the real application components with example data in the visual harness, without a native profile or live server. Each one comes in both themes, `name.png` dark and `name-light.png` light; the website shows the reader's theme and its build fails when a light copy is missing. Inspect the images before committing; do not draw or retouch interface elements. Keep captions and alt text beside the task they illustrate, and link images to their full-size copies. The website enhances these links with a modal image viewer; direct image links remain the fallback without JavaScript.

Before uploading a Pages artifact, `pages.yml` runs `npm run site:test`: the
website unit tests and Chromium and WebKit checks for the landing page, guide and comparison.
The website tests serve their own files and do not build the application's visual
harness. Pages always checks out `master`, including on a release event, so
publishing an older app tag does not replace the website with an older design.

The public guide describes how to use FTPeach, not one particular version. Do not
document features that are not in a released version yet; keep their
instructions in the relevant development document until release. Small visual
differences from the released app, such as a restyled button in a screenshot,
are fine.
Published source links and supporting technical documents point to the build's
Git commit; the changelog and security policy intentionally point to `master`.
Local previews with uncommitted edits still link to `HEAD`; commit the changes
and rebuild before checking their source links.

The comparison article lives separately in `site/compare.html`.
When a feature changes, review the article's FTPeach claims too. For competitor
claims, recheck the linked official sources and update the review date. Keep
product editions distinct; feature documentation is not a measured benchmark.

The [protocol reference](../docs/guide/protocol-reference.md) is the authoritative
compatibility table; `docs/protocol-support.md` only preserves old links. When
updating a protocol dependency, run the protocol tests and review this page.
`ssh_algorithm_reference_matches_client_defaults` compares its SSH table with
the library defaults; do not update the expected table blindly. Changes to
connection configuration still need review even if those defaults stay the same.

Describe protocol fixtures without credentials. Architectural boundaries are documented in `docs/architecture.md` and `docs/frontend-architecture.md`. New IPC capabilities, secrets, paths, and remote names require a security review.

## Comments and API documentation

Ordinary comments should explain only a non-obvious current invariant, limitation, or design reason. Do not preserve migration history or descriptions of removed implementations in source code; Git history and `docs/` are the appropriate places for that information.

- Start a module with a header of one to three lines (`//!` in Rust, a `/** ... */` block in TypeScript) when it says what the module is responsible for and its name does not. A small file whose name says it all needs none.
- Mark code that works around a defect elsewhere, in a library, WebView2, Windows or a server, with `workaround: <reason>`, naming what it works around, so it can be found and removed once the cause is gone.
- Write comments in English, and do not cite task, audit or plan numbers: a reader cannot look them up, so the reason goes into the comment itself.

Existing files are brought in line one module at a time, together with other changes to that module, not in changes of their own.

Document public Rust items with `///`. Use rustdoc links for available structures, traits, and functions, such as `[Store]` and [`Store::apply_layout`]. In React and TypeScript, use JSDoc (`/** ... */`) and links such as `{@link Application}` or `{@link normalizeCommandError}`. Single-line `//` comments do not replace public API documentation.
