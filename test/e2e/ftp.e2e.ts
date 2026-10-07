// FTP through the real window, IPC and Rust backend to a real server. Every
// result is judged by reading the server's own disk and the local disk, never
// by the application's word for it.
//
// The server is IIS FTP from scripts/test-servers/iis.ps1 unless the
// FTPEACH_E2E_FTP_* variables name another; FTPEACH_E2E_FTP_ROOT is the folder
// the FTP account lands in, read directly from disk. The error tests use the
// permission fixtures iis.ps1 creates under fixtures/perms.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import {
  copyAcross,
  localPane,
  openFolder,
  payload,
  queueRow,
  remotePane,
  runningRow,
  serverTest,
  settledRow,
  sha256,
  startConnecting,
  uniqueName,
  waitConnected,
  type Server,
} from './panes.ts';

const server: Server = {
  protocol: 'FTP',
  host: process.env.FTPEACH_E2E_FTP_HOST ?? '127.0.0.1',
  port: process.env.FTPEACH_E2E_FTP_PORT ?? '2121',
  user: process.env.FTPEACH_E2E_FTP_USER ?? 'ftpeach_test',
  password: process.env.FTPEACH_E2E_FTP_PASSWORD ?? 'FTPeach-test-2026!',
  root: process.env.FTPEACH_E2E_FTP_ROOT ?? 'C:\\ftpeach-test-servers\\iis\\FTPeachTestFtp',
};

const test = serverTest(server, 'run iis.ps1 install');

async function connect(page: Page) {
  await startConnecting(page, server);
  await waitConnected(page);
}

test('a file uploaded over FTP through the window lands on the server byte for byte', async ({
  serverRoot,
  app,
}) => {
  const { page } = app;
  const bytes = payload();
  const name = uniqueName();
  writeFileSync(path.join(app.workDir, name), bytes);

  await openFolder(localPane(page), app.workDir);
  await localPane(page).getByText(name, { exact: true }).waitFor({ timeout: 15_000 });
  await connect(page);
  await copyAcross(localPane(page), name);
  await expect(await settledRow(page, name)).toHaveAccessibleName(/: Done\b/);

  // The server's own copy: there under its name, nothing else beside it (no
  // staging file left), same bytes.
  expect(serverRoot.added()).toEqual([name]);
  const landed = readFileSync(path.join(server.root, name));
  expect(landed.length).toBe(bytes.length);
  expect(sha256(landed)).toBe(sha256(bytes));

  // And the pane the file went to lists it.
  await expect(remotePane(page).getByText(name, { exact: true })).toBeVisible({ timeout: 15_000 });
});

test('a file downloaded over FTP through the window lands on this computer byte for byte', async ({
  serverRoot,
  app,
}) => {
  const { page } = app;
  const bytes = payload();
  const name = uniqueName();
  writeFileSync(path.join(server.root, name), bytes);

  await openFolder(localPane(page), app.workDir);
  await connect(page);
  await copyAcross(remotePane(page), name);
  await expect(await settledRow(page, name)).toHaveAccessibleName(/: Done\b/);

  expect(readdirSync(app.workDir)).toEqual([name]);
  const landed = readFileSync(path.join(app.workDir, name));
  expect(landed.length).toBe(bytes.length);
  expect(sha256(landed)).toBe(sha256(bytes));
  // The download read the server's file, never changed it.
  expect(serverRoot.added()).toEqual([name]);
  expect(sha256(readFileSync(path.join(server.root, name)))).toBe(sha256(bytes));
  await expect(localPane(page).getByText(name, { exact: true })).toBeVisible({ timeout: 15_000 });
});

test('an upload onto an existing name changes nothing until Overwrite is chosen', async ({
  serverRoot,
  app,
}) => {
  const { page } = app;
  const name = uniqueName();
  const old = payload();
  const fresh = payload();
  writeFileSync(path.join(server.root, name), old);
  writeFileSync(path.join(app.workDir, name), fresh);

  await openFolder(localPane(page), app.workDir);
  await connect(page);
  await remotePane(page).getByText(name, { exact: true }).waitFor({ timeout: 15_000 });

  // Cancel: the server keeps the old bytes and no transfer starts.
  await copyAcross(localPane(page), name);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(
    new RegExp(`${escape(name)}\\S*" already exists in the destination folder`),
  );
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(queueRow(page, name)).toHaveCount(0);
  expect(serverRoot.added()).toEqual([name]);
  expect(sha256(readFileSync(path.join(server.root, name)))).toBe(sha256(old));

  // Overwrite: the server ends with the new bytes and nothing beside them.
  await copyAcross(localPane(page), name);
  await dialog.getByRole('button', { name: 'Overwrite', exact: true }).click();
  await expect(await settledRow(page, name)).toHaveAccessibleName(/: Done\b/);
  expect(serverRoot.added()).toEqual([name]);
  expect(sha256(readFileSync(path.join(server.root, name)))).toBe(sha256(fresh));
});

test.describe('with a speed limit, so a transfer is still running when Stop is pressed', () => {
  // 3 MB at 256 KB/s takes about twelve seconds.
  test.use({ appSettings: { transferSpeedLimitKBps: 256 } });

  test('stopping an upload over an existing file keeps the old file untouched', async ({
    serverRoot,
    app,
  }) => {
    const { page } = app;
    const name = uniqueName();
    const old = payload();
    writeFileSync(path.join(server.root, name), old);
    writeFileSync(path.join(app.workDir, name), payload());

    await openFolder(localPane(page), app.workDir);
    await connect(page);
    await remotePane(page).getByText(name, { exact: true }).waitFor({ timeout: 15_000 });
    await copyAcross(localPane(page), name);
    await page.getByRole('dialog').getByRole('button', { name: 'Overwrite', exact: true }).click();

    // Bytes are on their way, into a staging file beside the old one.
    const running = runningRow(page, name);
    await running.waitFor({ timeout: 30_000 });
    expect(serverRoot.added().length).toBeGreaterThan(1);
    await running.getByRole('button', { name: 'Stop', exact: true }).click();

    await expect(await settledRow(page, name)).toHaveAccessibleName(/: Cancelled\b/);
    // The old file was never touched. IIS deletes an aborted upload itself, so
    // the staging file going away proves nothing about FTPeach's own cleanup;
    // that needs a server that keeps partial uploads.
    await expect.poll(() => serverRoot.added(), { timeout: 15_000 }).toEqual([name]);
    expect(sha256(readFileSync(path.join(server.root, name)))).toBe(sha256(old));
  });

  // Pausing aborts the STOR, and IIS deletes an aborted upload: what was sent
  // is gone when Resume comes, so the upload has to start over, not fail and
  // not append to nothing.
  test('a paused upload resumes to the exact file even after the server dropped the partial one', async ({
    serverRoot,
    app,
  }) => {
    const { page } = app;
    const name = uniqueName();
    const bytes = payload();
    writeFileSync(path.join(app.workDir, name), bytes);

    await openFolder(localPane(page), app.workDir);
    await connect(page);
    await copyAcross(localPane(page), name);
    const running = runningRow(page, name);
    await running.waitFor({ timeout: 30_000 });
    await running.getByRole('button', { name: 'Pause', exact: true }).click();

    const paused = queueRow(page, name, 'Paused');
    await paused.waitFor({ timeout: 15_000 });
    // The case this test is about: nothing of the upload is left on the server.
    await expect.poll(() => serverRoot.added(), { timeout: 15_000 }).toEqual([]);
    await paused.getByRole('button', { name: 'Resume', exact: true }).click();

    await expect(await settledRow(page, name)).toHaveAccessibleName(/: Done\b/);
    expect(serverRoot.added()).toEqual([name]);
    expect(sha256(readFileSync(path.join(server.root, name)))).toBe(sha256(bytes));
  });
});

test('a server that refuses an upload reports an error, and the next upload still works', async ({
  serverRoot,
  app,
}) => {
  const { page } = app;
  const refusing = path.join(server.root, 'fixtures', 'perms', 'read-only-dir');
  expect(existsSync(refusing), `${refusing} (run iis.ps1 install)`).toBe(true);
  const before = readdirSync(refusing);
  const name = uniqueName();
  const bytes = payload();
  writeFileSync(path.join(app.workDir, name), bytes);

  await openFolder(localPane(page), app.workDir);
  await connect(page);
  await openFolder(remotePane(page), '/fixtures/perms/read-only-dir');
  await remotePane(page).getByText('inner.txt', { exact: true }).waitFor({ timeout: 15_000 });
  await copyAcross(localPane(page), name);

  const failed = await settledRow(page, name);
  await expect(failed).toHaveAccessibleName(/: Error\b/);
  await expect(failed.locator('.t-sub.err')).not.toBeEmpty();
  expect(readdirSync(refusing)).toEqual(before);

  // The same connection carries on: the file goes to the root instead.
  await openFolder(remotePane(page), '/');
  await remotePane(page).getByText('fixtures', { exact: true }).waitFor({ timeout: 15_000 });
  await copyAcross(localPane(page), name);
  await expect(queueRow(page, name, 'Done\\b')).toHaveCount(1, { timeout: 60_000 });
  expect(serverRoot.added()).toEqual([name]);
  expect(sha256(readFileSync(path.join(server.root, name)))).toBe(sha256(bytes));
});
