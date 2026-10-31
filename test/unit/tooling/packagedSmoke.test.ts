import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { smokeAppPath, smokeProfileEnvironment } from '../../../scripts/packaged-smoke/harness.ts';

test('the smoke harness launches the executable name of each desktop platform', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    assert.equal(path.basename(smokeAppPath(platform)), 'app');
  }
  assert.equal(path.basename(smokeAppPath('win32')), 'app.exe');
});

test('Unix smoke data is isolated through HOME and the XDG folders', () => {
  const profile = path.join(path.sep, 'tmp', 'smoke-profile');
  assert.deepEqual(smokeProfileEnvironment(profile, 'linux'), {
    HOME: profile,
    LOCALAPPDATA: profile,
    XDG_CONFIG_HOME: path.join(profile, 'config'),
    XDG_DATA_HOME: path.join(profile, 'data'),
    XDG_CACHE_HOME: path.join(profile, 'cache'),
    XDG_STATE_HOME: path.join(profile, 'state'),
  });
  assert.deepEqual(smokeProfileEnvironment(profile, 'darwin'), {
    HOME: profile,
    LOCALAPPDATA: profile,
    XDG_CONFIG_HOME: path.join(profile, 'config'),
    XDG_DATA_HOME: path.join(profile, 'data'),
    XDG_CACHE_HOME: path.join(profile, 'cache'),
    XDG_STATE_HOME: path.join(profile, 'state'),
  });
});

test('Windows keeps its existing profile and WebView2 isolation', () => {
  const profile = path.join('C:', 'smoke-profile');
  assert.deepEqual(smokeProfileEnvironment(profile, 'win32'), {
    APPDATA: profile,
    LOCALAPPDATA: profile,
    WEBVIEW2_USER_DATA_FOLDER: path.join(profile, 'webview2'),
  });
  assert.deepEqual(smokeProfileEnvironment(profile, 'win32', true), {
    APPDATA: profile,
    LOCALAPPDATA: profile,
  });
});
