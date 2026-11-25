import { expect, test } from '@playwright/test';

test("a disconnected pane's sign-in form ends level with the other pane's column header", async ({
  page,
}) => {
  await page.goto('/test/visual/visual.html');
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

  // A single-line connection error fits inside the bottom reserve without
  // shifting the form's bottom edge relative to the other pane's header.
  await right.locator('.protocol-select-trigger').click();
  await page.locator('.protocol-select-dropdown').getByRole('option', { name: 'WebDAV' }).click();
  await right.getByRole('textbox', { name: 'Address', exact: true }).fill('bad');
  await right.getByRole('button', { name: 'Connect', exact: true }).click();
  const error = form.locator('> .conn-error');
  await expect(error).toBeVisible();
  expect((await error.boundingBox())!.height).toBeCloseTo(20, 1);
  expect(await bottom(form)).toBeCloseTo(await bottom(header), 1);
});
