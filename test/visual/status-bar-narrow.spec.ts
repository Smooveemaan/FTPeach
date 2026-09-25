import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readdirSync } from 'node:fs';

const languages = readdirSync(new URL('../../src/i18n/locales/', import.meta.url))
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.slice(0, -'.json'.length));

async function open(page: Page, language: string, search: string) {
  await page.goto(`/visual.html?lang=${language}&${search}`);
  await expect(page.locator('html')).toHaveAttribute('lang', language);
  await expect(page.locator('.status-transfers')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/* The harness always has a transfer running. In the narrowest window the pane
   counts make way for it, and whatever an update needs — its version and its
   action or progress — still fits whole, in every language. */
for (const language of languages) {
  test(`narrow status bar keeps the update whole during a transfer (${language})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 480, height: 520 });
    for (const update of ['available', 'downloading&percent=42', 'downloaded']) {
      await open(page, language, `update=${update}`);
      const status = page.locator('.status-update');
      await expect(status).toBeVisible();
      await expect(page.locator('.status-right > span')).toHaveCount(0);
      const cut = await status.evaluate((element) => {
        const bar = element.closest('.status-bar')!.getBoundingClientRect();
        const left = element.closest('.status-left')!.getBoundingClientRect();
        const own = element.getBoundingClientRect();
        return Math.max(own.right - Math.min(bar.right, left.right), left.left - own.left);
      });
      expect(cut, update).toBeLessThanOrEqual(0.5);
    }
  });
}

test('a wide window keeps the pane counts during a transfer', async ({ page }) => {
  await open(page, 'en', 'update=available');
  await expect(page.locator('.status-right > span')).toHaveCount(2);
});
