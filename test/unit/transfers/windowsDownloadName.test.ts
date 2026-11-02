import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWindowsDownloadName } from '../../../src/features/transfers/windowsDownloadName.ts';
import names from '../../fixtures/windows-names.json' with { type: 'json' };

test('download validation rejects traversal and empty segments at any depth', () => {
  for (const name of ['', '.', '..', 'a/../b', 'a//b', '/a', 'a\\']) {
    assert.throws(() => validateWindowsDownloadName(name), /Windows doesn't allow the name/, name);
  }
  for (const name of ['file.txt', 'dir/sub/file', 'dir\\file']) {
    assert.doesNotThrow(() => validateWindowsDownloadName(name));
  }
});

test('the renderer pre-check gives the same verdict as the backend on every shared name', () => {
  for (const name of names.rejected) {
    assert.throws(
      () => validateWindowsDownloadName(name),
      /Windows doesn't allow the name/,
      JSON.stringify(name),
    );
  }
  for (const name of names.accepted) {
    assert.doesNotThrow(() => validateWindowsDownloadName(name), JSON.stringify(name));
  }
});
