import assert from 'node:assert/strict';
import test from 'node:test';
import { runSast, sastDockerArgs, sastFixtureDockerArgs } from '../../../scripts/checks/sast.ts';

const image =
  'semgrep/semgrep@sha256:34ab619bf1391a24bfda3f05debd0d8a6ce3093c2d5f9d39cfc00f83c1397823';

test('SAST passes the repository path to Docker without shell expansion', () => {
  assert.deepEqual(sastDockerArgs('/work/FTPeach'), [
    'run',
    '--rm',
    '-v',
    '/work/FTPeach:/src',
    '-w',
    '/src',
    image,
    'sh',
    '-c',
    'mkdir -p /tmp/ftpeach-sast/src-tauri && cp -a /src/.git /src/.gitignore /src/.semgrep /src/src /tmp/ftpeach-sast/ && cp -a /src/src-tauri/src /tmp/ftpeach-sast/src-tauri/ && cd /tmp/ftpeach-sast && exec semgrep scan --config .semgrep/security.yml --error --strict --metrics=off --disable-version-check src-tauri/src src',
  ]);

  const windowsArgs = sastDockerArgs('C:\\work space\\FTPeach');
  assert.equal(windowsArgs[windowsArgs.indexOf('-v') + 1], 'C:\\work space\\FTPeach:/src');
});

test('SAST runs each fixture with the pinned image before scanning', () => {
  const calls: string[][] = [];
  const outputs = ['All tests passed', 'All tests passed', 'scan complete'];
  const status = runSast('/work/FTPeach', (_command, args) => {
    calls.push(args);
    return { status: 0, stdout: outputs.shift()!, stderr: '' };
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [
    sastFixtureDockerArgs('/work/FTPeach', '.semgrep/security.rs'),
    sastFixtureDockerArgs('/work/FTPeach', '.semgrep/security.tsx'),
    sastDockerArgs('/work/FTPeach'),
  ]);
  assert.deepEqual(sastFixtureDockerArgs('/work/FTPeach', '.semgrep/security.rs'), [
    'run',
    '--rm',
    '-v',
    '/work/FTPeach:/src',
    '-w',
    '/src',
    image,
    'semgrep',
    'scan',
    '--test',
    '--config',
    '.semgrep/security.yml',
    '.semgrep/security.rs',
    '--metrics=off',
    '--disable-version-check',
  ]);
});

test('SAST stops after a fixture exits nonzero', () => {
  let calls = 0;
  const status = runSast('/work/FTPeach', () => {
    calls += 1;
    return { status: 3, stdout: 'fixture failed', stderr: '' };
  });

  assert.equal(status, 3);
  assert.equal(calls, 1);
});

test('SAST rejects a zero fixture exit without a successful test marker', () => {
  let calls = 0;
  const status = runSast('/work/FTPeach', () => {
    calls += 1;
    return { status: 0, stdout: 'No unit tests found', stderr: '' };
  });

  assert.equal(status, 1);
  assert.equal(calls, 1);
});

test('SAST does not scan after the second fixture fails', () => {
  let calls = 0;
  const status = runSast('/work/FTPeach', () => {
    calls += 1;
    return calls === 1
      ? { status: 0, stdout: 'All tests passed', stderr: '' }
      : { status: 0, stdout: 'No unit tests found', stderr: '' };
  });

  assert.equal(status, 1);
  assert.equal(calls, 2);
});
