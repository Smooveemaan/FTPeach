// Which halves of CI a push has to run.
//
// The rule "src/* is frontend" was wrong for two files: the Rust crate compiles
// `src/shared/settingsDefaults.json` and `src/i18n/locales/en.json` into itself
// with `include_str!`, so editing either could break the backend build while CI
// ran only the frontend jobs. A file's extension or directory does not decide
// who depends on it, so the crossings are listed here, ahead of the general
// rules, and the logic lives in a script with tests rather than inline in YAML.
import { appendFile } from 'node:fs/promises';

export interface ChangeClassification {
  rust: boolean;
  frontend: boolean;
}

/**
 * Files that live on one side and are built into the other. Keep in step with
 * the `include_str!` paths in `src-tauri/src/`.
 */
export const CROSS_LANGUAGE_SOURCES: readonly string[] = [
  'src/shared/settingsDefaults.json',
  'src/shared/executableExtensions.json',
  'src/i18n/locales/en.json',
];

/**
 * Paths that drive neither build: only lint-test-build, which runs on every push,
 * reads them. Documentation; the website, which pages.yml checks; the unit and
 * component tests and their tools' configs; images for the README and the site;
 * GitHub settings other than workflows; scripts no CI job runs (test/e2e runs
 * with a release, in installer.yml).
 */
const NO_BUILD = new RegExp(
  [
    String.raw`(?:^|/)[^/]+\.md$`,
    String.raw`^(?:LICENSE|\.gitattributes|\.gitignore|\.editorconfig)$`,
    String.raw`^(?:site|scripts/site|assets|test/unit|test/component|test/e2e)/`,
    String.raw`^(?:vitest|eslint)\.config\.ts$|^\.prettierrc\.json$|^\.prettierignore$`,
    String.raw`^\.github/(?!workflows/)`,
    String.raw`^scripts/(?:benchmarks|manual-tests|test-servers|release)/|^scripts/clean\.ps1$`,
  ].join('|'),
);

// protocol-reference.md: a Rust test checks its SSH algorithm table against the
// library's defaults (test/unit/tooling/classifyChanges.test.ts finds every such file).
const RUST_ONLY =
  /^src-tauri\/|^\.cargo\/|^rust-toolchain\.toml$|^scripts\/cargo\.ts$|^scripts\/coverage\/|^docs\/guide\/protocol-reference\.md$/;

const FRONTEND_ONLY =
  /^src\/|^public\/|^index\.html$|^vite\.config\.ts$|^tsconfig[^/]*\.json$|^playwright\.config\.ts$|^test\/visual\//;

/**
 * Classifies changed repository paths, as they come out of
 * `git diff --name-only`. A deleted or renamed file is just a path here: it is
 * classified the same way, because losing a file affects the same build that
 * having it did.
 */
export function classifyChanges(paths: Iterable<string>): ChangeClassification {
  const result = { rust: false, frontend: false };
  for (const raw of paths) {
    const path = raw.trim();
    if (path === '') continue;
    if (CROSS_LANGUAGE_SOURCES.includes(path)) {
      result.rust = true;
      result.frontend = true;
      continue;
    }
    if (RUST_ONLY.test(path)) {
      result.rust = true;
      continue;
    }
    if (FRONTEND_ONLY.test(path)) {
      result.frontend = true;
      continue;
    }
    if (NO_BUILD.test(path)) continue;
    // Workflows, check scripts, manifests, lockfiles, test fixtures: an
    // unrecognised owner counts as both rather than as neither.
    result.rust = true;
    result.frontend = true;
  }
  return result;
}

/** Splits `git diff -z` output, which is NUL-separated, or plain lines. */
export function splitPaths(input: string): string[] {
  return input.split(/\0|\r?\n/);
}

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const { rust, frontend } = classifyChanges(splitPaths(Buffer.concat(chunks).toString('utf8')));
  const line = `rust=${rust}\nfrontend=${frontend}\n`;
  process.stdout.write(line);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, line);
}

if (import.meta.filename === process.argv[1]) await main();
