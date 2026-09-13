import { expect, test } from '@playwright/test';

test('large queue fits offscreen names and supports keyboard navigation at RTL zoom', async ({
  page,
}) => {
  await page.goto('/visual.html');
  await expect(page.locator('.pane-list').first()).toBeVisible();
  await page.evaluate(async () => {
    const path = '/src/features/transfers/transferStore.ts';
    const store = await import(/* @vite-ignore */ path);
    store.setTransfersStore(
      Object.fromEntries(
        Array.from({ length: 10_000 }, (_, i) => {
          const id = `large-${i}`;
          return [
            id,
            {
              id,
              name: i === 9999 ? 'W'.repeat(100) : id,
              direction: 'down',
              protocol: 'sftp',
              connectionId: 'visual-remote',
              remoteFile: id,
              localTarget: `C:/${id}`,
              bytes: 10,
              total: 100,
              status: 'paused',
              startedAt: 10_000 - i,
            },
          ];
        }),
      ),
    );
  });
  await expect(page.locator('.transfer-item').first()).toContainText('large-0');
  expect(await page.locator('.transfer-item').count()).toBeLessThan(100);
  await page.locator('[data-column-key="file"] .col-resize-handle').dblclick();
  await expect
    .poll(async () => (await page.locator('[data-column-key="file"]').boundingBox())?.width ?? 0)
    .toBeGreaterThan(650);
  await page.setViewportSize({ width: 850, height: 700 });
  await page.evaluate(() => {
    document.documentElement.dir = 'rtl';
    document.documentElement.style.zoom = '1.25';
  });
  const list = page.locator('.transfer-list');
  await list.focus();
  await page.keyboard.press('End');
  await expect(page.locator('[data-transfer-index="9999"]')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.locator('[data-transfer-index="0"]')).toBeFocused();
  expect(await page.locator('.transfer-item').count()).toBeLessThan(100);
  const heights = await page
    .locator('.transfer-item')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
});
