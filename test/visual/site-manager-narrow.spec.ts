import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';

const localesUrl = new URL('../../src/i18n/locales/', import.meta.url);
const languages = readdirSync(localesUrl)
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.slice(0, -'.json'.length));

test('bookmark names retain descenders inside the clipping box', async ({ page }) => {
  await page.goto('/test/visual/visual.html?lang=en');
  await page.getByRole('menuitem', { name: 'Bookmarks', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Manage Bookmarks…' }).click();
  await page.evaluate(() => document.fonts.ready);
  const name = page.locator('.site-name').filter({ hasText: /^Staging$/ });
  const row = page.locator('.site-manage-row').filter({ has: name });
  for (const scale of [1, 1.5, 2]) {
    await page.locator('.modal-site-manager').evaluate((element, zoom) => {
      (element as HTMLElement).style.zoom = String(zoom);
    }, scale);
    await name.evaluate((element) => {
      element.style.overflow = '';
    });
    const clipped = await row.screenshot({ animations: 'disabled' });
    await name.evaluate((element) => {
      element.style.overflow = 'visible';
    });
    expect(clipped, `No text pixels should be clipped at scale ${scale}`).toEqual(
      await row.screenshot({ animations: 'disabled' }),
    );
  }
});

/* The smallest window at 150% interface scale is 480 / 1.5 CSS pixels wide.
   The bookmark toolbar still fits every button there, and the sort order
   whole, in every language. */
for (const language of languages) {
  test(`bookmark toolbar fits the narrowest scaled window (${language})`, async ({ page }) => {
    const locale = JSON.parse(readFileSync(new URL(`${language}.json`, localesUrl), 'utf8'));
    await page.goto(`/test/visual/visual.html?lang=${language}`);
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await page.getByRole('menuitem', { name: locale.menu.bookmarks.title }).click();
    await page.getByRole('menuitem', { name: locale.menu.file.manageBookmarks }).click();
    const toolbar = page.locator('.site-manage-toolbar');
    await expect(toolbar).toBeVisible();
    await page.setViewportSize({ width: 320, height: 347 });
    await page.evaluate(() => document.fonts.ready);
    const overflow = await toolbar.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return Math.max(
        ...[...element.querySelectorAll('button')].map((button) => {
          const own = button.getBoundingClientRect();
          return Math.max(own.right - box.right, box.left - own.left);
        }),
      );
    });
    expect(overflow).toBeLessThanOrEqual(0.5);
    await expect(toolbar.locator('.language-select-value')).not.toHaveClass(/truncated/);
  });
}
