import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateWindowsDownloadName,
  walkLocalDir,
  walkRemoteDir,
} from '../../../src/features/transfers/transferWalk.ts';
import type { FileEntry } from '../../../src/shared/types.ts';

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

test('local and remote walks preserve empty directories, relative names and file metadata', async () => {
  const tree: Record<string, FileEntry[]> = {
    root: [
      { name: 'sub', isDirectory: true },
      { name: 'empty', isDirectory: true },
      { name: 'zero', isDirectory: false, size: 0 },
    ],
    sub: [{ name: 'child', isDirectory: false, size: 42 }],
    empty: [],
  };
  const entries = (path: string) => tree[path.split(/[\\/]/).at(-1)!]!;
  const localCalls: (string | undefined)[] = [];
  const local = await walkLocalDir('C:\\root', 'root', 0, async (path) => {
    localCalls.push(path);
    return { ok: true, path: path!, entries: entries(path!) };
  });
  assert.deepEqual(local, {
    dirs: ['root/sub', 'root/empty'],
    files: [
      { local: 'C:\\root\\sub\\child', rel: 'root/sub/child', size: 42 },
      { local: 'C:\\root\\zero', rel: 'root/zero', size: 0 },
    ],
  });
  assert.deepEqual(localCalls, ['C:\\root', 'C:\\root\\sub', 'C:\\root\\empty']);
  const remoteCalls: string[][] = [];
  const remote = await walkRemoteDir('connection', '/root', 'root', 0, async (id, path) => {
    remoteCalls.push([id, path]);
    return { ok: true, path: '', entries: entries(path) };
  });
  assert.deepEqual(remote, {
    dirs: local.dirs,
    files: [
      { remote: '/root/sub/child', rel: 'root/sub/child' },
      { remote: '/root/zero', rel: 'root/zero' },
    ],
  });
  assert.deepEqual(remoteCalls, [
    ['connection', '/root'],
    ['connection', '/root/sub'],
    ['connection', '/root/empty'],
  ]);
});

test('walk depth 40 is allowed but descent beyond it fails before another listing', async () => {
  for (const remote of [false, true]) {
    let calls = 0;
    const list = async () => {
      calls++;
      return { ok: true, path: '', entries: [{ name: 'nested', isDirectory: true }] };
    };
    const walk = (depth: number) =>
      remote
        ? walkRemoteDir('id', '/root', 'root', depth, list)
        : walkLocalDir('C:\\root', 'root', depth, list);
    await assert.rejects(walk(40), /Folder nesting exceeds 40/);
    assert.equal(calls, 1);
    await assert.rejects(walk(41), /Folder nesting exceeds 40/);
    assert.equal(calls, 1);
    const failure = async () => ({ ok: false, path: '', error: 'denied', entries: [] });
    await assert.rejects(
      remote
        ? walkRemoteDir('id', '/root', 'root', 0, failure)
        : walkLocalDir('C:\\root', 'root', 0, failure),
      /root: denied/,
    );
    const empty = async () => ({ ok: true, path: '', entries: [] });
    assert.deepEqual(
      await (remote
        ? walkRemoteDir('id', '/root', 'root', 40, empty)
        : walkLocalDir('C:\\root', 'root', 40, empty)),
      { files: [], dirs: [] },
    );
  }
});
