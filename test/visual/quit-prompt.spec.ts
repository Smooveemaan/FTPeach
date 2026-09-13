import { expect, test } from '@playwright/test';

test('quitting with transfers running asks, then waits in the status bar', async ({ page }) => {
  await page.goto('/visual.html?tray=quitRequested');
  const dialog = page.locator('.modal-confirm');
  await expect(dialog).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const wait = dialog.getByRole('button', { name: 'Quit when transfers finish' });
  await expect(wait).toBeFocused();
  await expect(dialog).toHaveScreenshot('quit-prompt.png');

  await wait.click();
  await expect(dialog).toHaveCount(0);
  const pending = page.locator('.status-quit');
  await expect(pending).toContainText('Quitting after transfers finish');
  await expect(page.locator('.status-bar')).toHaveScreenshot('quit-pending-status-bar.png');

  await pending.getByRole('button', { name: 'Cancel' }).click();
  await expect(pending).toHaveCount(0);
});
