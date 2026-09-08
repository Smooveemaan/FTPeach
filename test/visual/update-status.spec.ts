import { expect, test } from '@playwright/test';

for (const width of [1440, 900, 480]) {
  for (const state of ['available', 'downloading', 'downloaded']) {
    test('update ' + state + ' at ' + width + 'px', async ({ page }) => {
      await page.setViewportSize({ width, height: 720 });
      await page.goto('/visual.html?update=' + state + '&percent=45');
      const update = page.locator('.status-update');
      await expect(update).toBeVisible();
      await expect(update.locator('bdi')).toHaveText('v0.3.2:');
      if (state === 'downloading') {
        const progress = update.getByRole('status');
        await expect(progress).toHaveText('45%');
        await expect(progress).toHaveAttribute('data-tooltip', 'Downloading');
        const color = await progress.evaluate((el) => getComputedStyle(el).color);
        await progress.hover();
        await expect(progress).toHaveCSS('color', color);
        await expect(update.getByRole('button')).toHaveCount(0);
      } else {
        const button = update.getByRole('button');
        await expect(button).toHaveText(state === 'available' ? 'available!' : 'install?');
        await expect(button).toHaveAttribute(
          'data-tooltip',
          state === 'available' ? 'Click to download' : 'Click to restart and install',
        );
        await expect(button).toHaveCSS('text-decoration-line', 'none');
        const color = await button.evaluate((el) => getComputedStyle(el).color);
        await button.hover();
        await expect(button).toHaveCSS('text-decoration-line', 'underline');
        await expect(button).not.toHaveCSS('color', color);
      }
      const bounds = await update.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      await expect(update.locator('svg')).toHaveCount(0);
      await expect(page.locator('.app-error-bar')).toHaveCount(0);
    });
  }
}

test('available update waits for a click, downloads, then offers installation', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/visual.html?update=available');
  const update = page.locator('.status-update');
  await expect(update.getByRole('button')).toHaveText('available!');
  await page.clock.fastForward(10000);
  await expect(update.getByRole('button')).toHaveText('available!');
  await update.getByRole('button').click();
  await expect(update.getByRole('status')).toHaveText('0%');
  await page.clock.runFor(2250);
  await expect(update.getByRole('status')).toHaveText('45%');
  await page.clock.runFor(2750);
  await expect(update.getByRole('button')).toHaveText('install?');
  await update.getByRole('button').click();
  await expect(update.getByRole('button')).toHaveText('install?');
});
