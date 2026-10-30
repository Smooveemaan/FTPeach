import assert from 'node:assert/strict';
import test from 'node:test';
import { sastDockerArgs } from '../../../scripts/checks/sast.ts';

test('SAST passes the repository path to Docker without shell expansion', () => {
  assert.deepEqual(sastDockerArgs('/work/FTPeach'), [
    'run',
    '--rm',
    '-v',
    '/work/FTPeach:/src',
    '-w',
    '/src',
    'semgrep/semgrep:1.176.1',
    'semgrep',
    'scan',
    '--config',
    '.semgrep/security.yml',
    '--error',
    '--strict',
    '--metrics=off',
    '--disable-version-check',
    'src-tauri/src',
    'src',
  ]);

  const windowsArgs = sastDockerArgs('C:\\work space\\FTPeach');
  assert.equal(windowsArgs[windowsArgs.indexOf('-v') + 1], 'C:\\work space\\FTPeach:/src');
});
