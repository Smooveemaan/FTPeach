import assert from 'node:assert/strict';
import test from 'node:test';
import {
  availableCopyName,
  namesMatchForTransfer,
} from '../../../src/features/transfers/nameConflict.ts';

const entries = (...names: string[]) => names.map((name) => ({ name }));

test('copy names preserve extensions and advance an existing copy marker', () => {
  assert.equal(availableCopyName('file.txt', [], 'local'), 'file (copy).txt');
  assert.equal(availableCopyName('file.tar.gz', [], 'local'), 'file.tar (copy).gz');
  assert.equal(availableCopyName('README', [], 'local'), 'README (copy)');
  assert.equal(availableCopyName('.env', [], 'local'), '.env (copy)');
  assert.equal(availableCopyName('file (copy).txt', [], 'local'), 'file (copy 2).txt');
  assert.equal(availableCopyName('file (copy 2).txt', [], 'local'), 'file (copy 3).txt');
});

test('copy names skip occupied candidates and reserve names already chosen in the batch', () => {
  const occupied = entries('FILE (COPY).txt', 'file (copy 2).txt');
  assert.equal(availableCopyName('file.txt', occupied, 'local'), 'file (copy 3).txt');
  assert.equal(availableCopyName('file.txt', occupied, 'remote'), 'file (copy).txt');
  occupied.push({ name: availableCopyName('file.txt', occupied, 'local') });
  assert.equal(availableCopyName('file.txt', occupied, 'local'), 'file (copy 4).txt');
});

test('macOS local name matching treats NFC and NFD forms as equivalent while remote stays exact', () => {
  const nfc = 'caf\u00e9.txt';
  const nfd = 'cafe\u0301.txt';
  assert.notEqual(nfc, nfd);
  assert.equal(namesMatchForTransfer('local', nfc, nfd, 'macos'), true);
  assert.equal(namesMatchForTransfer('remote', nfc, nfd, 'macos'), false);
  const occupied = entries('caf\u00e9 (copy).txt');
  assert.equal(availableCopyName(nfd, occupied, 'local', 'macos'), 'cafe\u0301 (copy 2).txt');
});
