// FTP through the real window, IPC and Rust backend to a real server. Every
// result is judged by reading the server's own disk and the local disk, never
// by the application's word for it.
//
// The server is IIS FTP from scripts/test-servers/iis.ps1 unless the
// FTPEACH_E2E_FTP_* variables name another; FTPEACH_E2E_FTP_ROOT is the folder
// the FTP account lands in, read directly from disk. The error tests use the
// permission fixtures iis.ps1 creates under fixtures/perms.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { test as appTest } from './app.ts';

const server = {
  host: process.env.FTPEACH_E2E_FTP_HOST ?? '127.0.0.1',
  port: process.env.FTPEACH_E2E_FTP_PORT ?? '2121',
  user: process.env.FTPEACH_E2E_FTP_USER ?? 'ftpeach_test',
  password: process.env.FTPEACH_E2E_FTP_PASSWORD ?? 'FTPeach-test-2026!',
  root: process.env.FTPEACH_E2E_FTP_ROOT ?? 'C:\\ftpeach-test-servers\\iis\\FTPeachTestFtp',
};

/**
 * The FTP root as it was before the test, and whatever the test added to it
 * removed afterwards, a timed-out test included.
 */
const test = appTest.extend<{ ftpRoot: { added: () => string[] } }>({
  // eslint-disable-next-line no-empty-pattern
  ftpRoot: async ({}, use) => {
    // A missing server is a broken setup, never a pass.
    expect(existsSync(server.root), `FTP root ${server.root} (run iis.ps1 install)`).toBe(true);
    const before = new Set(readdirSync(server.root));
    const added = () => readdirSync(server.root).filter((entry) => !before.has(entry));
    try {
      await use({ added });
    } finally {
      for (const entry of added()) {
        rmSync(path.join(server.root, entry), { recursive: true, force: true });
      }
    }
  },
});

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Not a multiple of any buffer size, so a lost or doubled last chunk shows. */
const payload = () => randomBytes(3 * 1024 * 1024 + 17);
const uniqueName = () => `e2e-${randomUUID()}.bin`;

const localPane = (page: Page) => page.locator('.pane[data-side=a]');
const remotePane = (page: Page) => page.locator('.pane[data-side=b]');

async function openFolder(pane: ReturnType<typeof localPane>, folder: string) {
  await pane.getByRole('button', { name: 'Edit path' }).press('Enter');
  await pane.locator('.path-input').fill(folder);
  await pane.locator('.path-input').press('Enter');
}

/** The right pane connects to the server through its connection bar. */
async function connect(page: Page) {
  const remote = remotePane(page);
  await remote.getByRole('textbox', { name: 'Address', exact: true }).fill(server.host);
  await remote.getByRole('textbox', { name: 'Port', exact: true }).fill(server.port);
  await remote.getByRole('textbox', { name: 'Username', exact: true }).fill(server.user);
  await remote.getByLabel('Password', { exact: true }).fill(server.password);
  await remote.getByRole('button', { name: 'Connect', exact: true }).click();
  await remote
    .getByRole('button', { name: 'Disconnect', exact: true })
    .waitFor({ timeout: 30_000 });
}

/** The queue row of a transfer, in any state or in the one given; a percentage may follow. */
const queueRow = (page: Page, name: string, status = '[^:]+') =>
  page.getByRole('group', { name: new RegExp(`${escape(name)}\\S*: ${status}`) });

/** Waits for the transfer to settle and returns the state it settled in. */
async function settledRow(page: Page, name: string) {
  const row = queueRow(page, name, '(Done|Error|Cancelled)\\b');
  await row.waitFor({ timeout: 60_000 });
  return row;
}

/** Selects a file in a pane and copies it to the other pane with F8. */
async function copyAcross(pane: ReturnType<typeof localPane>, name: string) {
  await pane.getByText(name, { exact: true }).click();
  await pane.page().keyboard.press('F8');
}

test('a file uploaded over FTP through the window lands on the server byte for byte', async ({
  ftpRoot,
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
  expect(ftpRoot.added()).toEqual([name]);
  const landed = readFileSync(path.join(server.root, name));
  expect(landed.length).toBe(bytes.length);
  expect(sha256(landed)).toBe(sha256(bytes));

  // And the pane the file went to lists it.
  await expect(remotePane(page).getByText(name, { exact: true })).toBeVisible({ timeout: 15_000 });
});

test('a file downloaded over FTP through the window lands on this computer byte for byte', async ({
  ftpRoot,
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
  expect(ftpRoot.added()).toEqual([name]);
  expect(sha256(readFileSync(path.join(server.root, name)))).toBe(sha256(bytes));
  await expect(localPane(page).getByText(name, { exact: true })).toBeVisible({ timeout: 15_000 });
});

test('an upload onto an existing name changes nothing until Overwrite is chosen', async ({
  ftpRoot,
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
  expect(ftpRoot.added()).toEqual([name]);
  expect(sha256(readFileSync(path.join(server.root, name)))).toBe(sha256(old));

  // Overwrite: the server ends with the new bytes and nothing beside them.
  await copyAcross(localPane(page), name);
  await dialog.getByRole('button', { name: 'Overwrite', exact: true }).click();
  await expect(await settledRow(page, name)).toHaveAccessibleName(/: Done\b/);
  expect(ftpRoot.added()).toEqual([name]);
  expect(sha256(readFileSync(path.join(server.root, name)))).toBe(sha256(fresh));
});

test.describe('with a speed limit, so a transfer is still running when Stop is pressed', () => {
  // 3 MB at 256 KB/s takes about twelve seconds.
  test.use({ appSettings: { transferSpeedLimitKBps: 256 } });

  test('stopping an upload over an existing file keeps the old file untouched', async ({
    ftpRoot,
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
    const running = queueRow(page, name, '[^:]+, [1-9]\\d?%$');
    await running.waitFor({ timeout: 30_000 });
    expect(ftpRoot.added().length).toBeGreaterThan(1);
    await running.getByRole('button', { name: 'Stop', exact: true }).click();

    await expect(await settledRow(page, name)).toHaveAccessibleName(/: Cancelled\b/);
    // The old file was never touched. IIS deletes an aborted upload itself, so
    // the staging file going away proves nothing about FTPeach's own cleanup;
    // that needs a server that keeps partial uploads.
    await expect.poll(() => ftpRoot.added(), { timeout: 15_000 }).toEqual([name]);
    expect(sha256(readFileSync(path.join(server.root, name)))).toBe(sha256(old));
  });
});

test('a server that refuses an upload reports an error, and the next upload still works', async ({
  ftpRoot,
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
  expect(ftpRoot.added()).toEqual([name]);
  expect(sha256(readFileSync(path.join(server.root, name)))).toBe(sha256(bytes));
});
