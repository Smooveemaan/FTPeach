import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
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
});

test('documentation runs neither half, and an unknown owner runs both', () => {
  assert.deepEqual(classifyChanges(['README.md', 'docs/security.md', 'LICENSE', '.gitignore']), {
    rust: false,
    frontend: false,
  });
  for (const path of ['package.json', '.github/workflows/checks.yml', 'scripts/checks/x.ts']) {
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
