import { expect, test } from '@playwright/test';

test("a disconnected pane's sign-in form ends level with the other pane's column header", async ({
  page,
}) => {
  await page.goto('/test/visual/visual.html');
  await page.evaluate(() => document.fonts.ready);
  const right = page.locator('.pane[data-side=b]');
  const disconnect = right.getByRole('button', { name: 'Disconnect' });
  await expect(disconnect).toBeVisible();
  const gapsOf = (container: ReturnType<typeof right.locator>) =>
    container.evaluate((el) => {
      const items = [...el.children].slice(0, 5).map((child) => child.getBoundingClientRect());
      return items.slice(1).map((rect, index) => Math.round(rect.left - items[index]!.right));
    });
  const sourceLeft = () =>
    right.locator('.pane-source-anchor').evaluate((el) => el.getBoundingClientRect().left);
  const connectedLeft = await sourceLeft();
  const connectedGaps = await gapsOf(right.locator('.pane-source-wrap'));
  expect(connectedGaps).toEqual([6, 6, 6, 6]);

  await disconnect.click();
  const form = right.locator('.connection-bar');
  await expect(form).toBeVisible();
  expect(await sourceLeft()).toBeCloseTo(connectedLeft, 1);
  expect(await gapsOf(form.locator('.connection-row:not(.connection-row-credentials)'))).toEqual(
    connectedGaps,
  );
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
