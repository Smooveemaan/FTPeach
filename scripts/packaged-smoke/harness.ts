import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(scriptDirectory, '..', '..');
const APP_PATH = path.join(REPO_ROOT, '.tools', 'smoke-target', 'debug', 'app.exe');

/** What a portable copy must have put beside the program by the time it exits. */
const PORTABLE_DATA = ['settings.json', 'tabs.json', 'local', 'webview'];

/**
 * Runs the smoke build with an isolated profile. With `portable`, the build is
 * copied into a folder of its own with the `FTPeach.portable` marker; its data
 * must then land in `data` beside it and the profile must stay empty.
 */
export async function runPackagedSmoke({ portable = false, timeoutMs = 30_000 } = {}) {
  const isolatedRoot = mkdtempSync(path.join(tmpdir(), 'ftpeach-smoke-'));
  const profile = path.join(isolatedRoot, 'profile');
  const program = path.join(isolatedRoot, 'program');
  mkdirSync(profile);
  let appPath = APP_PATH;
  if (portable) {
    mkdirSync(program);
    appPath = path.join(program, 'FTPeach.exe');
    copyFileSync(APP_PATH, appPath);
    writeFileSync(path.join(program, 'FTPeach.portable'), '');
  }
  const resultPath = path.join(isolatedRoot, 'result.txt');
  const child = spawn(appPath, [], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      APPDATA: profile,
      LOCALAPPDATA: profile,
      FTPEACH_SMOKE_TEST: '1',
      FTPEACH_SMOKE_RESULT: resultPath,
    },
    stdio: process.env.TAURI_DRIVER_DEBUG ? 'inherit' : 'ignore',
  });

  try {
    const deadline = Date.now() + timeoutMs;
    let lastPhase = 'process-started';
    let successReported = false;
    while (Date.now() < deadline) {
      if (existsSync(resultPath)) {
        const result = readFileSync(resultPath, 'utf8');
        lastPhase = result;
        if (result === 'ok') successReported = true;
        if (result === 'backend-ready') {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        if (!successReported) throw new Error(result);
      }
      if (child.exitCode !== null) {
        if (successReported && child.exitCode === 0) {
          if (portable) assertPortableData(program, profile);
          return;
        }
        throw new Error(`FTPeach smoke process exited early with code ${child.exitCode}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `packaged smoke test timed out after ${timeoutMs} ms (last phase: ${lastPhase})`,
    );
  } finally {
    if (child.exitCode === null) child.kill();
    // WebView2 can hold its profile for a moment after the process is gone.
    rmSync(isolatedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

function assertPortableData(program: string, profile: string) {
  const data = path.join(program, 'data');
  const missing = PORTABLE_DATA.filter((name) => !existsSync(path.join(data, name)));
  if (missing.length > 0) {
    throw new Error(`the portable copy did not store ${missing.join(', ')} in ${data}`);
  }
  const leaked = readdirSync(profile);
  if (leaked.length > 0) {
    throw new Error(`the portable copy wrote to the Windows profile: ${leaked.join(', ')}`);
  }
}
