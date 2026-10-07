// FTP through the real window, IPC and Rust backend to a real server. Every
// result is judged by reading the server's own disk and the local disk, never
// by the application's word for it.
//
// The server is IIS FTP from scripts/test-servers/iis.ps1 unless the
// FTPEACH_E2E_FTP_* variables name another; FTPEACH_E2E_FTP_ROOT is the folder
// the FTP account lands in, read directly from disk. The error tests use the
// permission fixtures iis.ps1 creates under fixtures/perms.
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import {
  connectBookmark,
  copyAcross,
  fileRow,
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
  tree,
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
  await fileRow(localPane(page), name).waitFor({ timeout: 15_000 });
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
  await expect(fileRow(remotePane(page), name)).toBeVisible({ timeout: 15_000 });
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
  await expect(fileRow(localPane(page), name)).toBeVisible({ timeout: 15_000 });
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
  await fileRow(remotePane(page), name).waitFor({ timeout: 15_000 });

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
    await fileRow(remotePane(page), name).waitFor({ timeout: 15_000 });
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
  await fileRow(remotePane(page), 'inner.txt').waitFor({ timeout: 15_000 });
  await copyAcross(localPane(page), name);

  const failed = await settledRow(page, name);
  await expect(failed).toHaveAccessibleName(/: Error\b/);
  await expect(failed.locator('.t-sub.err')).not.toBeEmpty();
  expect(readdirSync(refusing)).toEqual(before);

  // The same connection carries on: the file goes to the root instead.
  await openFolder(remotePane(page), '/');
  await fileRow(remotePane(page), 'fixtures').waitFor({ timeout: 15_000 });
  await copyAcross(localPane(page), name);
  await expect(queueRow(page, name, 'Done\\b')).toHaveCount(1, { timeout: 60_000 });
  expect(serverRoot.added()).toEqual([name]);
  expect(sha256(readFileSync(path.join(server.root, name)))).toBe(sha256(bytes));
});

test('a folder uploaded over FTP arrives whole: every file, its bytes and its empty folders', async ({
  serverRoot,
  app,
}) => {
  const { page } = app;
  const folder = `e2e-${randomUUID()}`;
  const local = path.join(app.workDir, folder);
  for (const dir of ['sub/deeper', 'empty', 'sub/empty-too']) {
    mkdirSync(path.join(local, dir), { recursive: true });
  }
  for (const file of ['a.bin', 'sub/b.bin', 'sub/deeper/c.bin']) {
    writeFileSync(path.join(local, file), randomBytes(70_001));
  }

  await openFolder(localPane(page), app.workDir);
  await connect(page);
  await copyAcross(localPane(page), folder);
  await expect(await settledRow(page, folder)).toHaveAccessibleName(/: Done\b/);

  expect(serverRoot.added()).toEqual([folder]);
  expect(tree(path.join(server.root, folder))).toEqual(tree(local));
});

test('a file renamed on the server is there under the new name only, unchanged', async ({
  serverRoot,
  app,
}) => {
  const { page } = app;
  const name = uniqueName();
  const renamed = uniqueName();
  const bytes = payload();
  writeFileSync(path.join(server.root, name), bytes);

  await connect(page);
  const remote = remotePane(page);
  await fileRow(remote, name).click();
  await page.keyboard.press('F2');
  await remote.locator('.rename-input').fill(renamed);
  await remote.locator('.rename-input').press('Enter');

  await expect.poll(() => serverRoot.added(), { timeout: 15_000 }).toEqual([renamed]);
  expect(sha256(readFileSync(path.join(server.root, renamed)))).toBe(sha256(bytes));
  await expect(fileRow(remote, renamed)).toBeVisible({ timeout: 15_000 });
  await expect(fileRow(remote, name)).toHaveCount(0);
});

test('Move to puts a server file into a folder there and takes it from where it was', async ({
  serverRoot,
  app,
}) => {
  const { page } = app;
  const name = uniqueName();
  const folder = `e2e-${randomUUID()}`;
  const bytes = payload();
  writeFileSync(path.join(server.root, name), bytes);
  mkdirSync(path.join(server.root, folder));

  await connect(page);
  const remote = remotePane(page);
  await fileRow(remote, name).click();
  await page.keyboard.press('F6');
  await page.getByRole('dialog').getByRole('menuitem', { name: folder, exact: true }).click();

  await expect.poll(() => serverRoot.added(), { timeout: 15_000 }).toEqual([folder]);
  expect(tree(path.join(server.root, folder))).toEqual([`${name} ${sha256(bytes)}`]);
  await expect(fileRow(remote, name)).toHaveCount(0);
});

test.describe('with a bookmark whose default folder holds hard names', () => {
  const bookmark = 'IIS FTP names';
  test.use({
    appStore: {
      'sites.json': [
        {
          id: 'e2e-ftp-names',
          name: bookmark,
          protocol: 'ftp',
          host: server.host,
          port: Number(server.port),
          user: server.user,
          // Saved in plain text by an older version; protected on first read.
          plain: server.password,
          remotePath: '/fixtures/names',
        },
      ],
    },
  });

  test('connecting from the bookmark opens its folder and lists exactly what the server holds', async ({
    app,
  }) => {
    const folder = path.join(server.root, 'fixtures', 'names');
    expect(existsSync(folder), `${folder} (run iis.ps1 install)`).toBe(true);
    await connectBookmark(app.page, bookmark);

    // Spaces at both ends, punctuation, accents, Cyrillic, CJK, emoji and a
    // 255-character name: each listed under its own name, none lost or added.
    const listed = remotePane(app.page).locator('[role=option][data-name]');
    await expect
      .poll(
        async () =>
          (await listed.evaluateAll((rows) => rows.map((row) => row.dataset.name))).sort(),
        {
          timeout: 15_000,
        },
      )
      .toEqual(readdirSync(folder).sort());
  });
});

test('after a wrong password the same pane connects with the right one and works', async ({
  serverRoot,
  app,
}) => {
  const { page } = app;
  const name = uniqueName();
  const bytes = payload();
  writeFileSync(path.join(app.workDir, name), bytes);
  await openFolder(localPane(page), app.workDir);

  await startConnecting(page, { ...server, password: 'not-the-password' });
  const remote = remotePane(page);
  await expect(remote).toContainText('Incorrect username or password', { timeout: 30_000 });
  await expect(remote.getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(0);

  await remote.getByLabel('Password', { exact: true }).fill(server.password);
  await remote.getByRole('button', { name: 'Connect', exact: true }).click();
  await waitConnected(page);
  await copyAcross(localPane(page), name);
  await expect(await settledRow(page, name)).toHaveAccessibleName(/: Done\b/);
  expect(serverRoot.added()).toEqual([name]);
  expect(sha256(readFileSync(path.join(server.root, name)))).toBe(sha256(bytes));
});
