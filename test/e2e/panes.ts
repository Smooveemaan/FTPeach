// What every transfer test does through the window: open a folder in a pane,
// connect the right pane, copy across with F8 and read the queue, plus the
// server folder the test may only add to.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { test as appTest } from './app.ts';

export interface Server {
  protocol: 'FTP' | 'SFTP';
  host: string;
  port: string;
  user: string;
  password: string;
  /** The folder the account lands in, read directly from disk. */
  root: string;
}

/**
 * The test API with `app` and `serverRoot`: the server folder as it was
 * before the test, and whatever the test added to it removed afterwards, a
 * timed-out test included.
 */
export function serverTest(server: Server, setup: string) {
  return appTest.extend<{ serverRoot: { added: () => string[] } }>({
    // eslint-disable-next-line no-empty-pattern
    serverRoot: async ({}, use) => {
      // A missing server is a broken setup, never a pass.
      expect(existsSync(server.root), `${server.protocol} root ${server.root} (${setup})`).toBe(
        true,
      );
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
}

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Not a multiple of any buffer size, so a lost or doubled last chunk shows. */
export const payload = () => randomBytes(3 * 1024 * 1024 + 17);
export const uniqueName = () => `e2e-${randomUUID()}.bin`;
/** The staging files FTPeach writes beside an upload's destination. */
export const isStaging = (name: string) => /^\.ftpeach-.*\.part$/.test(name);

export const localPane = (page: Page) => page.locator('.pane[data-side=a]');
export const remotePane = (page: Page) => page.locator('.pane[data-side=b]');

export async function openFolder(pane: Locator, folder: string) {
  await pane.getByRole('button', { name: 'Edit path' }).press('Enter');
  await pane.locator('.path-input').fill(folder);
  await pane.locator('.path-input').press('Enter');
}

/** Fills the right pane's connection bar and presses Connect. */
export async function startConnecting(page: Page, server: Server) {
  const remote = remotePane(page);
  if (server.protocol !== 'FTP') {
    await remote.locator('.protocol-select-trigger').click();
    await page.getByRole('option', { name: server.protocol, exact: true }).click();
  }
  await remote.getByRole('textbox', { name: 'Address', exact: true }).fill(server.host);
  await remote.getByRole('textbox', { name: 'Port', exact: true }).fill(server.port);
  await remote.getByRole('textbox', { name: 'Username', exact: true }).fill(server.user);
  await remote.getByLabel('Password', { exact: true }).fill(server.password);
  await remote.getByRole('button', { name: 'Connect', exact: true }).click();
}

export async function waitConnected(page: Page) {
  await remotePane(page)
    .getByRole('button', { name: 'Disconnect', exact: true })
    .waitFor({ timeout: 30_000 });
}

/** The queue row of a transfer, in any state or in the one given; a percentage may follow. */
export const queueRow = (page: Page, name: string, status = '[^:]+') =>
  page.getByRole('group', { name: new RegExp(`${escape(name)}\\S*: ${status}`) });

/** A row whose transfer is under way, past its first percent. */
export const runningRow = (page: Page, name: string) => queueRow(page, name, '[^:]+, [1-9]\\d?%$');

/** Waits for the transfer to settle and returns its row. */
export async function settledRow(page: Page, name: string) {
  const row = queueRow(page, name, '(Done|Error|Cancelled)\\b');
  await row.waitFor({ timeout: 60_000 });
  return row;
}

/** Selects a file in a pane and copies it to the other pane with F8. */
export async function copyAcross(pane: Locator, name: string) {
  await pane.getByText(name, { exact: true }).click();
  await pane.page().keyboard.press('F8');
}
