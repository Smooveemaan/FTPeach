import { expect, test } from '@playwright/test';
import type { Page } from 'playwright-core';
import en from '../../src/i18n/locales/en.json' with { type: 'json' };
import ru from '../../src/i18n/locales/ru.json' with { type: 'json' };

async function openHarness(page: Page, language?: string) {
  await page.goto(language ? `/visual.html?lang=${language}` : '/visual.html');
  await expect(page.locator('.pane-list').first()).toBeVisible();
  await expect(page.getByText('Production', { exact: true }).first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** The app applies `dir` asynchronously, once `changeLanguage` resolves — so a
 * screenshot taken before that lands would be a left-to-right render under an
 * Arabic locale, which is neither layout and would bake in as a false
 * baseline. */
async function openRtlHarness(page: Page) {
  await openHarness(page, 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.evaluate(() => document.fonts.ready);
}

test('desktop workspace', async ({ page }) => {
  await openHarness(page);
  await expect(page).toHaveScreenshot('workspace-desktop.png');
});

test('startup defers optional dialogs until they are opened', async ({ page }) => {
  const loadedDialogs: string[] = [];
  page.on('request', (request) => {
    if (/\/(SettingsDialog|SiteManagerDialog|OpenWithDialog)\.tsx/.test(request.url())) {
      loadedDialogs.push(request.url());
    }
  });
  await openHarness(page);
  expect(loadedDialogs).toEqual([]);
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await page.getByRole('menuitem', { name: 'Settings…' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(loadedDialogs.some((url) => url.includes('/SettingsDialog.tsx'))).toBe(true);
});

test('narrow workspace', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 720 });
  await openHarness(page);
  await expect(page).toHaveScreenshot('workspace-narrow.png');
});

/* Dragging the transfer queue up collapses the panes to their title and path
   rows. The panes start on a fraction of a pixel below the 28.8px title bar,
   and a pane that rounds that fraction too tall shows the top of its column
   header between the path and the transfer queue. */
for (const log of [false, true]) {
  test(`transfer queue dragged to the top stops at the pane headers with the log ${
    log ? 'shown' : 'hidden'
  }`, async ({ page }) => {
    await openHarness(page);
    const resizers = page.locator('.section-resizer');
    await expect(resizers).toHaveCount(1);
    if (log) {
      await page.locator(`[data-tooltip="${en.viewToolbar.toggleLog}"]`).first().click();
      await expect(resizers).toHaveCount(2);
    }
    const box = (await resizers.first().boundingBox())!;
    await page.mouse.move(box.x + 200, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, 0, { steps: 10 });
    await page.mouse.up();
    const overhangs = await page
      .locator('.pane')
      .evaluateAll((panes) =>
        panes.map(
          (pane) =>
            pane.getBoundingClientRect().bottom -
            pane.querySelector('.pane-path:not(.pane-path-measure)')!.getBoundingClientRect()
              .bottom,
        ),
      );
    expect(overhangs).toHaveLength(2);
    for (const overhang of overhangs) {
      expect(overhang).toBeLessThanOrEqual(0);
      expect(overhang).toBeGreaterThan(-1);
    }
  });
}

/* Eighteen files branch on `dir === 'rtl'` by hand — drag offsets, column
   resize signs, menu anchors — and until these two baselines existed nothing
   rendered that branch at all. They also stand in for the CSS that has no
   other test: the truncation masks and the transfer columns' alignment, both
   of which read the wrong edge if they slip back to a physical direction. */
test('rtl workspace', async ({ page }) => {
  await openRtlHarness(page);
  await expect(page).toHaveScreenshot('workspace-rtl.png');
});

test('rtl narrow workspace', async ({ page }) => {
  // Narrow enough that the transfer queue's own columns truncate, which is
  // what puts the fade masks and their direction into the frame.
  await page.setViewportSize({ width: 900, height: 720 });
  await openRtlHarness(page);
  await expect(page).toHaveScreenshot('workspace-rtl-narrow.png');
});

/* The pane toolbar clips to fold its buttons into the overflow menu, and a
   pressed button shifts 1px down — which must stay inside that clip, or the
   button loses its bottom border while held. */
test('pressed pane toolbar button stays inside the toolbar clip', async ({ page }) => {
  await openHarness(page);
  const home = page
    .locator('.pane-toolbar')
    .first()
    .locator(`button[data-tooltip="${en.filePane.homeFolder}"]`);
  await expect(home).toBeEnabled();
  const box = await home.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  const geometry = await home.evaluate((button) => ({
    pressed: getComputedStyle(button).transform !== 'none',
    buttonBottom: button.getBoundingClientRect().bottom,
    clipBottom: button.parentElement!.getBoundingClientRect().bottom,
  }));
  await page.mouse.up();
  expect(geometry.pressed).toBe(true);
  expect(geometry.buttonBottom).toBeLessThanOrEqual(geometry.clipBottom);
});

test('settings dialog', async ({ page }) => {
  await openHarness(page);
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await page.getByRole('menuitem', { name: 'Settings…' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveScreenshot('settings-dialog.png');
});

test('site manager dialog', async ({ page }) => {
  await openHarness(page);
  await page.getByRole('menuitem', { name: 'Bookmarks' }).click();
  await page.getByRole('menuitem', { name: 'Manage Bookmarks…' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveScreenshot('site-manager-dialog.png');
});

test('Save connection opens the prefilled bookmark form and saves edits', async ({ page }) => {
  await openHarness(page, 'en');
  await page.evaluate(() => {
    window.api.sites.save = async (payload) => {
      Reflect.set(window, 'savedSitePayload', payload);
      return { ok: true };
    };
  });
  await page.locator(`button[data-tooltip="${en.menu.file.saveConnection}"]`).click();
  const dialog = page.getByRole('dialog', { name: en.siteManagerDialog.titleNew });
  await expect(
    dialog.getByRole('textbox', { name: en.siteManagerDialog.fields.name, exact: true }),
  ).toHaveValue('sftp.example.com');
  await expect(
    dialog.getByRole('textbox', { name: en.connectionBar.fields.address, exact: true }),
  ).toHaveValue('sftp.example.com');
  await expect(
    dialog.getByRole('textbox', { name: en.connectionBar.fields.port, exact: true }),
  ).toHaveValue('22');
  await expect(
    dialog.getByRole('textbox', { name: en.connectionBar.fields.user, exact: true }),
  ).toHaveValue('deploy');
  await expect(
    dialog.getByRole('textbox', { name: en.siteManagerDialog.fields.remotePath, exact: true }),
  ).toHaveValue('/var/www');
  await dialog
    .getByRole('textbox', { name: en.connectionBar.fields.address, exact: true })
    .fill('new.example.com');
  await dialog.getByRole('button', { name: 'Folder', exact: true }).click();
  await expect(dialog.getByRole('option', { name: 'No folder' })).toBeVisible();
  await dialog.getByRole('option', { name: 'No folder' }).click();
  await dialog.getByRole('button', { name: en.common.save, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, 'savedSitePayload'))).toMatchObject({
    protocol: 'sftp',
    host: 'new.example.com',
    port: 22,
    user: 'deploy',
    remotePath: '/var/www',
    parentId: null,
  });
});

test('Save path opens the prefilled local-path form and keeps save errors visible', async ({
  page,
}) => {
  await openHarness(page, 'en');
  await page.evaluate(() => {
    window.api.sites.save = async () => ({ ok: false, error: 'Test save failed' });
  });
  await page.locator(`button[data-tooltip="${en.saveLocalPath.tooltip}"]`).click();
  const dialog = page.getByRole('dialog', { name: en.siteManagerDialog.titleNewLocalPath });
  await expect(
    dialog.getByRole('textbox', { name: en.siteManagerDialog.fields.name, exact: true }),
  ).toHaveValue('Projects');
  await expect(
    dialog.getByRole('textbox', { name: en.siteManagerDialog.fields.localPath, exact: true }),
  ).toHaveValue('C:\\Users\\developer\\Projects');
  await dialog.getByRole('button', { name: en.common.save, exact: true }).click();
  await expect(dialog.getByText('Test save failed')).toBeVisible();
  await page.evaluate(() => {
    window.api.sites.save = async (payload) => {
      Reflect.set(window, 'savedSitePayload', payload);
      return { ok: true };
    };
  });
  await dialog.getByRole('button', { name: en.common.save, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, 'savedSitePayload'))).toMatchObject({
    kind: 'local',
    name: 'Projects',
    localPath: 'C:\\Users\\developer\\Projects',
    icon: 'bookmark',
    parentId: null,
  });
});

test('icon picker shows a scrollable 3 by 3 grid', async ({ page }) => {
  await openHarness(page);
  await page.getByRole('menuitem', { name: 'Bookmarks' }).click();
  await page.getByRole('menuitem', { name: 'Manage Bookmarks…' }).click();
  await page.getByRole('button', { name: 'New Bookmark' }).click();
  await page.getByRole('button', { name: 'Icon' }).click();

  const picker = page.locator('.site-icon-dropdown');
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('menuitemradio')).toHaveCount(18);
  const geometry = await picker.evaluate((menu) => {
    const grid = menu.querySelector('.menu-items')!;
    return {
      menuHeight: menu.clientHeight,
      clientHeight: grid.clientHeight,
      scrollHeight: grid.scrollHeight,
      columns: getComputedStyle(grid).gridTemplateColumns,
    };
  });
  expect(geometry.columns.split(' ')).toHaveLength(3);
  expect(geometry.clientHeight).toBe(98);
  expect(geometry.menuHeight).toBe(108);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);

  const grid = picker.locator('.menu-items');
  const bottom = await grid.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  const lastIcon = picker.getByRole('menuitemradio').last();
  const box = await lastIcon.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.waitForTimeout(200);
  expect(await grid.evaluate((element) => element.scrollTop)).toBe(bottom);
});

test('sort field fits the longest translated option', async ({ page }) => {
  const widths: number[] = [];
  for (const locale of [
    { language: 'en', menu: en.menu.bookmarks.title, manage: en.menu.file.manageBookmarks },
    { language: 'ru', menu: ru.menu.bookmarks.title, manage: ru.menu.file.manageBookmarks },
  ]) {
    await openHarness(page, locale.language);
    await page.getByRole('menuitem', { name: locale.menu, exact: true }).click();
    await page.getByRole('menuitem', { name: locale.manage, exact: true }).click();
    const trigger = page.locator('.site-manage-sort-trigger');
    await expect(trigger).toBeVisible();
    const width = await trigger.evaluate((button) => button.getBoundingClientRect().width);
    widths.push(width);
    await trigger.click();
    const dropdown = page.locator('.site-manage-sort-dropdown:not(.select-menu-sizer)');
    await expect(dropdown).toBeVisible();
    expect(await dropdown.evaluate((menu) => menu.getBoundingClientRect().width)).toBe(width);
    const naturalWidth = await dropdown.evaluate((menu) => {
      (menu as HTMLElement).style.width = 'max-content';
      const measured = menu.getBoundingClientRect().width;
      (menu as HTMLElement).style.width = '';
      return measured;
    });
    expect(Math.abs(width - naturalWidth)).toBeLessThan(1);
    await dropdown.getByRole('option').nth(1).click();
    expect(await trigger.evaluate((button) => button.getBoundingClientRect().width)).toBe(width);
  }
  expect(widths[0]).not.toBe(widths[1]);
});

/* The connect empty state is at its tallest with the quicklist's cap of three
   saved sites, and at its most cramped in the default layout: the smallest
   window the app opens at, with the transfer queue and the log both taking
   their share of it. Its Manage Bookmarks button used to fall past the bottom
   edge there, and the scrollbar that appeared re-centred the whole card. */
test('three recent connections fit a disconnected pane in the default layout', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 740 });
  await openHarness(page);
  await page.locator(`[data-tooltip="${en.viewToolbar.toggleLog}"]`).first().click();
  await page.getByRole('menuitem', { name: en.menu.file.title, exact: true }).click();
  await page.getByRole('menuitem', { name: en.menu.file.disconnect, exact: true }).click();
  await expect(page.locator('.pane-quicklist-row')).toHaveCount(3);

  const list = page.locator('.pane-list-empty-scrollable');
  const geometry = await list.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const more = element.querySelector('.pane-quicklist-more')!.getBoundingClientRect();
    const card = element.querySelector('.pane-connect-quicklist')!.getBoundingClientRect();
    return {
      overflow: element.scrollHeight - element.clientHeight,
      buttonBottomGap: bounds.bottom - more.bottom,
      offCentre: card.left + card.width / 2 - (bounds.left + bounds.width / 2),
      contentWidth: element.clientWidth,
    };
  });
  expect(geometry.overflow).toBe(0);
  expect(geometry.buttonBottomGap).toBeGreaterThan(0);

  /* Short enough that the list has to scroll: the gutter is reserved on both
     edges, so the card sits where it sat and the rows keep their width. */
  await page.setViewportSize({ width: 1180, height: 560 });
  const scrolled = await list.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const card = element.querySelector('.pane-connect-quicklist')!.getBoundingClientRect();
    return {
      overflow: element.scrollHeight - element.clientHeight,
      offCentre: card.left + card.width / 2 - (bounds.left + bounds.width / 2),
      contentWidth: element.clientWidth,
    };
  });
  expect(scrolled.overflow).toBeGreaterThan(0);
  expect(scrolled.offCentre).toBeCloseTo(geometry.offCentre, 1);
  expect(scrolled.contentWidth).toBe(geometry.contentWidth);
});
