import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';

const languages = readdirSync(new URL('../../src/i18n/locales/', import.meta.url))
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.slice(0, -'.json'.length));

function strings(language: string) {
  const locale = JSON.parse(
    readFileSync(new URL(`../../src/i18n/locales/${language}.json`, import.meta.url), 'utf8'),
  );
  return {
    file: locale.menu.file.title as string,
    view: locale.menu.view.title as string,
    importSettings: locale.menu.file.importSettings as string,
    syncBrowsing: locale.menu.view.syncBrowsing as string,
    confirmImport: locale.importSettingsDialog.confirmLabel as string,
    includeBookmarks: locale.importSettingsDialog.includeBookmarks as string,
    includeLocalPaths: locale.importSettingsDialog.includeLocalPaths as string,
    bookmarks: locale.menu.bookmarks.title as string,
    manageBookmarks: locale.menu.file.manageBookmarks as string,
    importBookmarks: locale.siteManagerDialog.importBookmarks as string,
  };
}

/** Everything the status bar can show at once: an update, the wait to quit and sync browsing. */
async function crowd(page: Page, language: string) {
  const text = strings(language);
  await page.goto(`/visual.html?lang=${language}&update=available&tray=quitRequested&import=sites`);
  await expect(page.locator('html')).toHaveAttribute('lang', language);
  await page.evaluate(() => document.fonts.ready);
  const dialog = page.locator('.modal-confirm');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.status-quit')).toBeVisible();
  await page.getByRole('menuitem', { name: text.view, exact: true }).click();
  await page.getByRole('menuitem', { name: text.syncBrowsing }).click();
  await expect(page.locator('.sync-indicator')).toHaveCount(1);
  return text;
}

/** How far each part of the status bar cuts its text off, in pixels. */
async function cutOff(page: Page) {
  return page
    .locator('.status-bar')
    .evaluate((bar) =>
      Object.fromEntries(
        [bar, ...bar.querySelectorAll('.fit-shrink')].map((el, index) => [
          `${index} ${el.className}`,
          el.scrollWidth - el.clientWidth,
        ]),
      ),
    );
}

/* Everything at once -- a transfer, an update, the wait to quit, sync browsing
   and then an import message -- in every language, wide and narrow. The bar
   shortens what it can (see FIT in StatusBar.tsx) so nothing is cut off; only
   in the narrowest window may the status text itself give way, as a last
   resort. The message and the quit button always stay whole. */
for (const language of languages) {
  test(`status bar fits everything it can show at once (${language})`, async ({ page }) => {
    for (const width of [480, 720, 1000, 1400]) {
      await page.setViewportSize({ width, height: 600 });
      const text = await crowd(page, language);
      for (const [part, cut] of Object.entries(await cutOff(page))) {
        const allowed = width < 720 && part.includes('status-text') ? Infinity : 1;
        expect(cut, `${width}px ${part}`).toBeLessThanOrEqual(allowed);
      }

      await page.getByRole('menuitem', { name: text.file, exact: true }).click();
      await page.getByRole('menuitem', { name: text.importSettings }).click();
      await page.getByRole('checkbox', { name: text.includeBookmarks }).check();
      await page.getByRole('checkbox', { name: text.includeLocalPaths }).check();
      await page.getByRole('button', { name: text.confirmImport }).click();
      await expect(page.locator('.status-notice .notice-text')).toHaveCount(1);
      for (const [part, cut] of Object.entries(await cutOff(page))) {
        expect(cut, `${width}px with the message: ${part}`).toBeLessThanOrEqual(1);
      }
      const quit = await page.locator('.status-quit button').evaluate((button) => {
        const bar = button.closest('.status-bar')!.getBoundingClientRect();
        return button.getBoundingClientRect().right - bar.right;
      });
      expect(quit, `${width}px quit button`).toBeLessThanOrEqual(0);
    }
  });
}

/* The bookmark manager's footer repeats the message in the same two forms and
   never cuts it off either. */
for (const language of languages) {
  test(`bookmark manager footer fits the import message (${language})`, async ({ page }) => {
    const text = strings(language);
    for (const width of [480, 1400]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto(`/visual.html?lang=${language}&import=sites`);
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('.status-transfers')).toBeVisible();
      // A click that lands while the app is still starting can leave the menu shut,
      // or close it again under the pointer.
      const manage = page.getByRole('menuitem', { name: text.manageBookmarks });
      const footer = page.locator('.site-manager-footer');
      await expect(async () => {
        if (!(await manage.isVisible())) {
          await page.getByRole('menuitem', { name: text.bookmarks, exact: true }).click();
        }
        await manage.click({ timeout: 1000 });
        await expect(footer).toBeVisible({ timeout: 1000 });
      }).toPass();
      await page.getByRole('button', { name: text.importBookmarks, exact: true }).click();
      await page.getByRole('checkbox', { name: text.includeLocalPaths }).check();
      await page.getByRole('button', { name: text.confirmImport }).click();
      await expect(footer.locator('.notice-text')).toHaveCount(1);
      const cut = await footer.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(cut, `${width}px`).toBeLessThanOrEqual(1);
    }
  });
}

/* Dragging the window narrower and back: the bar shortens on the way down and
   gets its full texts back on the way up, without re-measuring every frame. */
test('status bar gets its full texts back when the window widens again', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 600 });
  await crowd(page, 'en');
  const sync = page.locator('.sync-indicator');
  const quit = page.locator('.status-quit');
  await expect(sync).toHaveText('⇄ Sync Pane Browsing');
  await expect(quit).toContainText('Quitting after transfers finish');
  for (let width = 1400; width >= 480; width -= 20)
    await page.setViewportSize({ width, height: 600 });
  await expect(sync).toHaveText('⇄');
  await expect(quit).toHaveText('Cancel quit');
  for (let width = 480; width <= 1400; width += 20)
    await page.setViewportSize({ width, height: 600 });
  await expect(sync).toHaveText('⇄ Sync Pane Browsing');
  await expect(quit).toContainText('Quitting after transfers finish');
});
