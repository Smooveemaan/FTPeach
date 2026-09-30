import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWindowsDownloadName } from '../../../src/features/transfers/transferWalk.ts';

test('download validation rejects forbidden segments, devices and traversal at any depth', () => {
  for (const name of [
    '',
    '.',
    '..',
    'a/../b',
    'a//b',
    '/a',
    'a\\',
    'a?.txt',
    'a:b',
    'a\u0000b',
    'a\u007fb',
    'name.',
    'name ',
    'con.txt',
    'LPT1',
    'COM³.log',
    'CONIN$',
  ]) {
    assert.throws(() => validateWindowsDownloadName(name), /Invalid Windows download name/, name);
  }
  for (const name of [
    'file.txt',
    'dir/sub/file',
    'dir\\file',
    'COM0',
    'COM10',
    'connection.txt',
    'report.final.txt',
    'مرحبا.txt',
  ]) {
    assert.doesNotThrow(() => validateWindowsDownloadName(name));
  }
});
