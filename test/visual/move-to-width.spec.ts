import { expect, test } from '@playwright/test';

/* The dialog is as wide as its folder names need, up to a cap, and never
   wider than the window: the smallest one at 150% scale is 320 CSS pixels. */
test('Move to is sized to its folder names, within the window', async ({ page }) => {
  await page.goto('/visual.html');
  await page
    .locator('.pane')
    .nth(1)
    .locator('.pane-list .row:not(.row-header)')
    .nth(2)
    .click({ button: 'right' });
  await page
    .locator('.context-menu .menu-item-label')
    .getByText('Move to', { exact: false })
    .click();
  const modal = page.locator('.modal-move-to');
  await expect(modal).toBeVisible();
  const width = async () => (await modal.boundingBox())!.width;
  // Two short names take less than the 420 pixels the dialog used to be.
  expect(await width()).toBeGreaterThanOrEqual(300);
  expect(await width()).toBeLessThan(420);
  await modal
    .locator('.move-to-name')
    .first()
    .evaluate((element) => {
      element.textContent = 'x'.repeat(200);
    });
  expect(await width()).toBe(560);
  await page.setViewportSize({ width: 320, height: 347 });
  expect(await width()).toBeLessThanOrEqual(280);
});
