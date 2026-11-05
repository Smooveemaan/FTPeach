import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test(
  'installer settings can be seeded before first launch and patched without losing values',
  {
    skip: process.platform !== 'win32',
  },
  async (t) => {
    const { changeSettings } = await import('../../e2e/install.ts');
    const directory = mkdtempSync(path.join(tmpdir(), 'installer-profile-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const profile = path.join(directory, 'new-profile');
    const file = path.join(profile, 'settings.json');
    changeSettings({ language: 'en', autoCheckUpdates: false }, profile);
    changeSettings({ theme: 'dark' }, profile);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      schemaVersion: 1,
      data: { language: 'en', autoCheckUpdates: false, theme: 'dark' },
    });
  },
);
