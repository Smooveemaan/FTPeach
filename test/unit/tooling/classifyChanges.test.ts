import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CROSS_LANGUAGE_SOURCES,
  classifyChanges,
  splitPaths,
} from '../../../scripts/checks/classify-changes.ts';

test('files compiled into both builds run both halves of CI', () => {
  for (const path of CROSS_LANGUAGE_SOURCES) {
    assert.deepEqual(classifyChanges([path]), { rust: true, frontend: true }, path);
  }
});

test('each side of the repository runs its own half', () => {
  assert.deepEqual(classifyChanges(['src/features/sites/useSites.ts']), {
    rust: false,
    frontend: true,
  });
  assert.deepEqual(classifyChanges(['src/i18n/locales/de.json']), { rust: false, frontend: true });
  assert.deepEqual(classifyChanges(['index.html', 'test/visual/panes.spec.ts']), {
    rust: false,
    frontend: true,
  });
  assert.deepEqual(classifyChanges(['src-tauri/src/protocol/ftp.rs', 'src-tauri/Cargo.toml']), {
    rust: true,
    frontend: false,
  });
  for (const path of ['rust-toolchain.toml', '.cargo/config.toml', 'scripts/cargo.ts']) {
    assert.deepEqual(classifyChanges([path]), { rust: true, frontend: false }, path);
  }
  assert.deepEqual(classifyChanges(['public/favicon.ico']), { rust: false, frontend: true });
});

test('what only the always-run jobs read runs neither half, and an unknown owner runs both', () => {
  for (const path of [
    'README.md',
    'docs/security.md',
    'LICENSE',
    '.gitignore',
    'site/index.html',
    'scripts/site/build.ts',
    'test/unit/tooling/siteBuild.test.ts',
    'test/component/transfers/useTransfers.test.tsx',
    'test/e2e/install.vm.ts',
    'vitest.config.ts',
    'eslint.config.ts',
    '.prettierrc.json',
    'assets/images/ftpeach.png',
    '.github/ISSUE_TEMPLATE/bug.yml',
    '.github/dependabot.yml',
    'scripts/release/portable.ts',
    'scripts/test-servers/iis.ps1',
  ]) {
    assert.deepEqual(classifyChanges([path]), { rust: false, frontend: false }, path);
  }
  for (const path of [
    'package.json',
    'package-lock.json',
    '.github/workflows/checks.yml',
    'scripts/checks/x.ts',
    'scripts/packaged-smoke/run.ts',
    'test/fixtures/updater/latest.json',
    '.semgrep/security.yml',
  ]) {
    assert.deepEqual(classifyChanges([path]), { rust: true, frontend: true }, path);
  }
});

test('a removed or renamed file is classified by its path like any other', () => {
  // `git diff --no-renames` reports a rename as a delete plus an add, and a
  // deletion still changes the build that compiled the file.
  assert.deepEqual(classifyChanges(['src/shared/settingsDefaults.json', 'docs/a.md']), {
    rust: true,
    frontend: true,
  });
});

test('empty and NUL-separated input is read the way git writes it', () => {
  assert.deepEqual(classifyChanges(splitPaths('')), { rust: false, frontend: false });
  assert.deepEqual(classifyChanges(splitPaths('\0\0')), { rust: false, frontend: false });
  assert.deepEqual(classifyChanges(splitPaths('docs/a.md\0src-tauri/src/lib.rs\0')), {
    rust: true,
    frontend: false,
  });
  assert.deepEqual(classifyChanges(splitPaths('docs/a.md\nsrc/main.tsx\n')), {
    rust: false,
    frontend: true,
  });
});

test('the listed crossings are the ones the crate actually compiles', async () => {
  const sources = await Promise.all(
    [
      'src/store/settings.rs',
      'src/store/settings_schema.rs',
      'src/runtime/log_messages.rs',
      'src/local_fs/local_open.rs',
    ].map((path) => readFile(new URL(`../../../src-tauri/${path}`, import.meta.url), 'utf8')),
  );
  const included = sources.join('\n');
  for (const path of CROSS_LANGUAGE_SOURCES) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    assert.ok(included.includes(name), `${path} is no longer compiled into the crate`);
  }
});

test('every file outside src-tauri that the crate compiles in runs the Rust half', async () => {
  const crate = fileURLToPath(new URL('../../../src-tauri/', import.meta.url));
  const root = path.resolve(crate, '..');
  const found: string[] = [];
  for (const entry of await readdir(path.join(crate, 'src'), { recursive: true })) {
    if (!entry.endsWith('.rs')) continue;
    const file = path.join(crate, 'src', entry);
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/include_(?:str|bytes)!\(\s*"([^"]+)"/g)) {
      const target = path.relative(root, path.resolve(path.dirname(file), match[1]!));
      if (!target.startsWith('src-tauri')) found.push(target.split(path.sep).join('/'));
    }
  }
  assert.ok(found.includes('docs/guide/protocol-reference.md'), 'the scan finds no includes');
  for (const target of found) {
    assert.equal(classifyChanges([target]).rust, true, target);
  }
});
