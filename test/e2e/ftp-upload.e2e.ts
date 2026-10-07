// Pilot of the desktop end-to-end suite: one upload through the real window,
// IPC and Rust backend to a real FTP server, judged by reading the server's own
// copy of the file, never by the application's word for it.
//
// The server is IIS FTP from scripts/test-servers/iis.ps1 unless the
// FTPEACH_E2E_FTP_* variables name another; FTPEACH_E2E_FTP_ROOT is the folder
// the FTP account lands in, read directly from disk.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
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

test('a file uploaded over FTP through the window lands on the server byte for byte', async ({
  ftpRoot,
  app,
}) => {
  const { page } = app;
  // Not a multiple of any buffer size, so a lost or doubled last chunk shows.
  const payload = randomBytes(3 * 1024 * 1024 + 17);
  const name = `e2e-${randomUUID()}.bin`;
  writeFileSync(path.join(app.workDir, name), payload);

  // The left pane shows this computer: open the folder holding the file.
  const local = page.locator('.pane[data-side=a]');
  await local.getByRole('button', { name: 'Edit path' }).press('Enter');
  await local.locator('.path-input').fill(app.workDir);
  await local.locator('.path-input').press('Enter');
  await local.getByText(name, { exact: true }).waitFor({ timeout: 15_000 });

  // The right pane connects to the server through its connection bar.
  const remote = page.locator('.pane[data-side=b]');
  await remote.getByRole('textbox', { name: 'Address', exact: true }).fill(server.host);
  await remote.getByRole('textbox', { name: 'Port', exact: true }).fill(server.port);
  await remote.getByRole('textbox', { name: 'Username', exact: true }).fill(server.user);
  await remote.getByLabel('Password', { exact: true }).fill(server.password);
  await remote.getByRole('button', { name: 'Connect', exact: true }).click();
  await remote
    .getByRole('button', { name: 'Disconnect', exact: true })
    .waitFor({ timeout: 30_000 });

  // Select the file and copy it to the other pane with its shortcut.
  await local.getByText(name, { exact: true }).click();
  await page.keyboard.press('F8');

  // The queue row settles, and says it is done.
  const row = page.getByRole('group', {
    name: new RegExp(`${escape(name)}\\S*: (Done|Error|Cancelled)`),
  });
  await row.waitFor({ timeout: 60_000 });
  await expect(row).toHaveAccessibleName(new RegExp(`${escape(name)}\\S*: Done`));

  // The server's own copy, read from its disk: it is there under its name,
  // nothing else appeared beside it (no staging file left), same bytes.
  expect(ftpRoot.added()).toEqual([name]);
  const landed = readFileSync(path.join(server.root, name));
  expect(landed.length).toBe(payload.length);
  expect(sha256(landed)).toBe(sha256(payload));

  // And the pane the file went to lists it.
  await expect(remote.getByText(name, { exact: true })).toBeVisible({ timeout: 15_000 });
});
