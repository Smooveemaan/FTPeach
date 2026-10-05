import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Every visible control a keyboard or screen-reader user can reach, described
 * by the ones that have no accessible name. A tooltip (`data-tooltip`) and a
 * placeholder are not names: neither is announced as one.
 */
function unnamedControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const selector = [
      'button',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      'a[href]',
      '[role="button"]',
      '[role="switch"]',
      '[role="checkbox"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[role="combobox"]',
      '[role="slider"]',
    ].join(',');
    const text = (element: Element | null) => element?.textContent?.trim() ?? '';
    const nameOf = (element: HTMLElement): string => {
      const label = element.getAttribute('aria-label')?.trim();
      if (label) return label;
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const joined = labelledBy
          .split(/\s+/)
          .map((id) => text(document.getElementById(id)))
          .join(' ')
          .trim();
        if (joined) return joined;
      }
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement
      ) {
        const fromLabel = Array.from(element.labels ?? [])
          .map(text)
          .join(' ')
          .trim();
        if (fromLabel) return fromLabel;
        if (element instanceof HTMLInputElement && ['button', 'submit'].includes(element.type)) {
          return element.value.trim();
        }
        return element.title.trim();
      }
      return (
        text(element) ||
        element.title.trim() ||
        Array.from(element.querySelectorAll('img[alt]'))
          .map((img) => img.getAttribute('alt') ?? '')
          .join(' ')
          .trim()
      );
    };
    return Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter((element) => element.getClientRects().length > 0 && !element.closest('[inert]'))
      .filter((element) => !nameOf(element))
      .map((element) => {
        const classes = element.className
          ? `.${String(element.className).split(/\s+/).join('.')}`
          : '';
        const hint = element.getAttribute('placeholder') ?? element.getAttribute('type') ?? '';
        return `${element.tagName.toLowerCase()}${classes}${hint ? ` [${hint}]` : ''}${element.dataset.tooltip ? ` (tooltip: ${element.dataset.tooltip})` : ''}`;
      });
  });
}

async function openWithTransfers(page: Page, search = '') {
  await page.goto(`/test/visual/visual.html${search}`);
  await expect(page.locator('.pane-list').first()).toBeVisible();
  await page.evaluate(async () => {
    const path = '/src/features/transfers/transferStore.ts';
    const store = await import(/* @vite-ignore */ path);
    const base = {
      direction: 'down',
      protocol: 'sftp',
      connectionId: 'visual-remote',
      bytes: 10,
      total: 100,
      startedAt: 1,
    };
    store.setTransfersStore(
      Object.fromEntries(
        (['active', 'paused', 'error', 'queued', 'done'] as const).map((status, index) => [
          status,
          {
            ...base,
            id: status,
            name: `${status}.bin`,
            remoteFile: `/${status}.bin`,
            localTarget: `C:/${status}.bin`,
            status,
            error: status === 'error' ? 'Connection lost' : undefined,
            startedAt: index,
          },
        ]),
      ),
    );
  });
}

for (const [name, search] of [
  ['main window', ''],
  ['main window in RTL', '?lang=ar'],
] as const) {
  test(`every control in the ${name} has an accessible name`, async ({ page }) => {
    await openWithTransfers(page, search);
    await expect(page.locator('.transfer-item').first()).toBeVisible();
    expect(await unnamedControls(page)).toEqual([]);
  });
}

test('every control in the connection bar has a name for each protocol', async ({ page }) => {
  await page.goto('/test/visual/visual.html');
  const pane = page.locator('.pane').nth(1);
  await expect(pane).toBeVisible();
  // The bar's fields only show while no connection is open.
  await pane.getByRole('button', { name: 'Disconnect' }).click();
  const protocol = pane.locator('button[aria-haspopup="listbox"]').first();
  await expect(protocol).toBeEnabled();
  for (let index = 0; index < 4; index += 1) {
    await protocol.click();
    await page.getByRole('option').nth(index).click();
    expect(await unnamedControls(page), await protocol.innerText()).toEqual([]);
    const keyAuth = pane.locator('.secure-toggle input[type="checkbox"]');
    if ((await protocol.innerText()).includes('SFTP') && (await keyAuth.count()) > 0) {
      await keyAuth.first().check();
      expect(await unnamedControls(page), 'SFTP with a key').toEqual([]);
    }
  }
});

test('every control in every settings section has an accessible name', async ({ page }) => {
  await page.goto('/test/visual/visual.html');
  await expect(page.locator('.pane-list').first()).toBeVisible();
  await page.locator('.menu-bar-trigger').nth(1).click();
  await page.locator('.menu-dropdown .menu-item').first().click();
  const sections = page.locator('.settings-nav-item');
  await expect(sections.first()).toBeVisible();
  for (let index = 0; index < (await sections.count()); index += 1) {
    await sections.nth(index).click();
    expect(await unnamedControls(page), await sections.nth(index).innerText()).toEqual([]);
  }
});

test('every control in the site manager has an accessible name, and the rest is inert', async ({
  page,
}) => {
  await page.goto('/test/visual/visual.html');
  await page.locator('.pane').nth(1).getByRole('button', { name: 'Manage Bookmarks…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect(await unnamedControls(page)).toEqual([]);
  // Behind the dialog nothing takes focus, but the window can still be moved.
  expect(
    await page.evaluate(() =>
      Boolean(document.querySelector('.menu-bar-trigger')?.closest('[inert]')),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => Boolean(document.querySelector('.title-bar')?.closest('[inert]'))),
  ).toBe(false);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => document.querySelectorAll('[inert]').length)).toBe(0);
});
