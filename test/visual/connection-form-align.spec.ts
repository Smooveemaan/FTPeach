import { expect, test } from '@playwright/test';

test("a disconnected pane's sign-in form ends level with the other pane's column header", async ({
  page,
}) => {
  await page.goto('/visual.html');
  await page.evaluate(() => document.fonts.ready);
  const right = page.locator('.pane[data-side=b]');
  await right.getByRole('button', { name: 'Disconnect' }).click();
  const form = right.locator('.connection-bar');
  await expect(form).toBeVisible();
  const header = page.locator('.pane[data-side=a] .row-header');
  const bottom = async (box: typeof form) => {
    const rect = (await box.boundingBox())!;
    return rect.y + rect.height;
  };
  expect(await bottom(form)).toBeCloseTo(await bottom(header), 1);
});
