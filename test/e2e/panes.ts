// What every transfer test does through the window: open a folder in a pane,
// connect the right pane, copy across with F8 and read the queue, plus the
// server folder the test may only add to.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { test as appTest } from './app.ts';

export interface Server {
  protocol: 'FTP' | 'FTPS' | 'SFTP' | 'WebDAV';
  /** The host, or for WebDAV the whole address. */
  host: string;
  /** Empty for WebDAV, whose port is in the address. */
  port: string;
  /** WebDAV over http:// only: tick Allow unencrypted sign-in. */
  allowCleartext?: boolean;
  user: string;
  password: string;
  /** The folder the account lands in, read directly from disk. */
  root: string;
}

/**
 * What a test may leave on a server for its fixture to remove: names it made
 * (`e2e-…`) and the staging and set-aside files FTPeach writes beside them.
 */
export const isTestOwned = (name: string) => /^(e2e-|\.ftpeach-)/.test(name);

/**
 * The test API with `app` and `serverRoot`, which every test gets: the
 * server folder as it was before the test. Afterwards, a timed-out test
 * included, the test's own new names are removed; any other new name, or one
 * that was there and is gone, fails the test and is left as it is.
 */
export function serverTest(server: Server, setup: string) {
  return appTest.extend<{ serverRoot: { added: () => string[] } }>({
    serverRoot: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use) => {
        // A missing server is a broken setup, never a pass.
        expect(existsSync(server.root), `${server.protocol} root ${server.root} (${setup})`).toBe(
          true,
        );
        const before = new Set(readdirSync(server.root));
        const added = () => readdirSync(server.root).filter((entry) => !before.has(entry));
        try {
          await use({ added });
        } finally {
          const left = added();
          for (const entry of left.filter(isTestOwned)) {
            rmSync(path.join(server.root, entry), { recursive: true, force: true });
          }
          const now = new Set(readdirSync(server.root));
          expect(
            left.filter((entry) => !isTestOwned(entry)),
            `not the test's own, left in ${server.root}`,
          ).toEqual([]);
          expect(
            [...before].filter((entry) => !now.has(entry)),
            `gone from ${server.root}`,
          ).toEqual([]);
        }
      },
      // Set up before `app`, so it is torn down after the app and any editor have let go.
      { auto: true },
    ],
  });
}

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Not a multiple of any buffer size, so a lost or doubled last chunk shows. */
export const payload = () => randomBytes(3 * 1024 * 1024 + 17);
export const uniqueName = () => `e2e-${randomUUID()}.bin`;
/** The staging files FTPeach writes beside an upload's destination. */
export const isStaging = (name: string) => /^\.ftpeach-.*\.part$/.test(name);

/**
 * A folder's whole content, read from disk: `path/` for each folder, empty
 * ones included, and `path sha256` for each file, sorted. Names `skip`
 * accepts are left out unread, such as a staging file still being written.
 */
export function tree(root: string, skip: (_name: string) => boolean = () => false): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => !skip(entry.name))
    .map((entry) => {
      const full = path.join(entry.parentPath, entry.name);
      const relative = path.relative(root, full).replaceAll('\\', '/');
      return entry.isDirectory() ? `${relative}/` : `${relative} ${sha256(readFileSync(full))}`;
    })
    .sort();
}

export const localPane = (page: Page) => page.locator('.pane[data-side=a]');
export const remotePane = (page: Page) => page.locator('.pane[data-side=b]');

/** A file or folder in a pane's list, by its exact name; never the path bar. */
export const fileRow = (pane: Locator, name: string) =>
  pane.locator(`[role=option][data-name="${name.replace(/["\\]/g, '\\$&')}"]`);

/** Clicks a menu of the title bar, then one of its items, which may carry a check mark and a shortcut. */
export async function menu(page: Page, title: string, item: string) {
  await page.getByRole('menubar').getByRole('menuitem', { name: title, exact: true }).click();
  // A toggle or a choice of several is a menu item of its own kind.
  const name = new RegExp(`^${escape(item)}( |$)`);
  await page
    .getByRole('menuitem', { name })
    .or(page.getByRole('menuitemcheckbox', { name }))
    .or(page.getByRole('menuitemradio', { name }))
    .click();
}

export async function openFolder(pane: Locator, folder: string) {
  // Again from the start when the field goes away: a session still loading
  // after a start redraws the pane and closes it.
  await expect(async () => {
    const input = pane.locator('.path-input');
    if (!(await input.isVisible()))
      await pane.getByRole('button', { name: 'Edit path' }).press('Enter', { timeout: 5_000 });
    await input.fill(folder, { timeout: 5_000 });
    await input.press('Enter', { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
}

/** Opens a folder by its path and waits for the pane to show it, empty or not. */
export async function showFolder(pane: Locator, folder: string) {
  await openFolder(pane, folder);
  await expect(pane.locator('.pane-path > .crumb[data-drop-path]').last()).toHaveAttribute(
    'data-drop-path',
    folder,
  );
}

let lastSelected = { name: '', time: 0 };

/**
 * Selects an entry. Two clicks on one name within half a second are a double
 * click, which opens it, so a second selection of the same name waits that out.
 */
export async function selectRow(pane: Locator, name: string) {
  const row = fileRow(pane, name);
  await row.waitFor({ timeout: 15_000 });
  const since = Date.now() - lastSelected.time;
  if (lastSelected.name === name && since < 600) await pane.page().waitForTimeout(600 - since);
  await row.click();
  lastSelected = { name, time: Date.now() };
  // A click that a new listing swallowed would leave the next key acting on nothing.
  await expect(row).toHaveAttribute('aria-selected', 'true');
}

/**
 * Copies `name` from the folder the pane shows into `folder` through the
 * clipboard, answering a name conflict with `answer`.
 */
export async function copyInto(pane: Locator, name: string, folder: string, answer?: string) {
  const page = pane.page();
  await selectRow(pane, name);
  await page.keyboard.press('Control+C');
  await showFolder(pane, folder);
  await page.keyboard.press('Control+V');
  if (answer) {
    await page.getByRole('dialog').getByRole('button', { name: answer, exact: true }).click();
  }
}

/** Waits for an error banner with `text` and closes it. */
export async function dismissAlert(page: Page, text: string | RegExp) {
  const shown = page.getByRole('alert').filter({ hasText: text });
  await expect(shown).toBeVisible({ timeout: 15_000 });
  await shown.getByRole('button', { name: 'Close' }).click();
  await expect(shown).toHaveCount(0);
}

/** Fills a pane's connection bar, the right one's unless told, and presses Connect. */
export async function startConnecting(page: Page, server: Server, remote = remotePane(page)) {
  if (server.protocol !== 'FTP') {
    await remote.locator('.protocol-select-trigger').click();
    await page.getByRole('option', { name: server.protocol, exact: true }).click();
  }
  await remote.getByRole('textbox', { name: 'Address', exact: true }).fill(server.host);
  if (server.port) {
    await remote.getByRole('textbox', { name: 'Port', exact: true }).fill(server.port);
  }
  if (server.allowCleartext) {
    await remote.getByRole('checkbox', { name: 'Allow unencrypted sign-in' }).check();
  }
  await remote.getByRole('textbox', { name: 'Username', exact: true }).fill(server.user);
  await remote.getByLabel('Password', { exact: true }).fill(server.password);
  await remote.getByRole('button', { name: 'Connect', exact: true }).click();
}

/** Connects the right pane from a saved bookmark, through Manage Bookmarks. */
export async function connectBookmark(page: Page, name: string) {
  await remotePane(page).getByRole('button', { name: 'Manage Bookmarks…', exact: true }).click();
  await page.getByRole('dialog').getByRole('treeitem', { name }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  await waitConnected(page);
}

export async function waitConnected(page: Page, pane = remotePane(page)) {
  await pane.getByRole('button', { name: 'Disconnect', exact: true }).waitFor({ timeout: 30_000 });
}

/** The queue row of a transfer, in any state or in the one given; a percentage may follow. */
export const queueRow = (page: Page, name: string, status = '[^:]+') =>
  page.getByRole('group', { name: new RegExp(`${escape(name)}\\S*: ${status}`) });

/** A row whose transfer is under way, past its first percent. */
export const runningRow = (page: Page, name: string) => queueRow(page, name, '[^:]+, [1-9]\\d?%$');

/**
 * Waits for a Done row of `name`. A test reads what a copy wrote only after
 * this: FTPeach holds the files it is writing and checking to itself, and a
 * reader in the middle would make the copy fail as a file in use.
 */
export async function waitDone(page: Page, name: string) {
  await queueRow(page, name, 'Done\\b').waitFor({ timeout: 60_000 });
}

/** Waits for the transfer to settle and returns its row. */
export async function settledRow(page: Page, name: string) {
  const row = queueRow(page, name, '(Done|Error|Cancelled)\\b');
  await row.waitFor({ timeout: 60_000 });
  return row;
}

/** Selects a file in a pane and copies it to the other pane with F8. */
export async function copyAcross(pane: Locator, name: string) {
  const row = fileRow(pane, name);
  // Two clicks on one name within half a second are a double click, which
  // opens the file. A selected row may have been clicked just now.
  if ((await row.getAttribute('aria-selected')) === 'true') await pane.page().waitForTimeout(600);
  await row.click();
  await pane.page().keyboard.press('F8');
}
