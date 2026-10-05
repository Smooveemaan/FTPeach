import { expect, test } from '@playwright/test';

// 500 rows is well past the virtualization threshold, so a row far down the
// list is not in the DOM until the list has scrolled to it.
test('keyboard navigation in a long list scrolls just far enough to show the row', async ({
  page,
}) => {
  await page.goto('/test/visual/visual.html?manyFiles=500');
  const list = page.locator('.pane-list[data-side="a"]');
  const row = (name: string) => list.locator(`.row[data-name="${name}"]`);
  const scrollTop = () => list.evaluate((el) => el.scrollTop);

  await row('file-0000.txt').click();
  const rowHeight = (await row('file-0000.txt').boundingBox())!.height;
  const visibleRows = Math.floor((await list.boundingBox())!.height / rowHeight);

  await page.keyboard.press('End');
  await expect(row('file-0499.txt')).toHaveClass(/selected/);
  await expect(row('file-0499.txt')).toBeInViewport({ ratio: 1 });
  const atEnd = await scrollTop();
  expect(atEnd).toBeGreaterThan(400 * rowHeight);

  // The row above is already on screen, so nothing scrolls.
  await page.keyboard.press('ArrowUp');
  await expect(row('file-0498.txt')).toHaveClass(/selected/);
  expect(await scrollTop()).toBe(atEnd);

  await page.keyboard.press('Home');
  await expect(row('file-0000.txt')).toHaveClass(/selected/);
  await expect.poll(scrollTop).toBe(0);

  // Walking off the bottom edge moves the list by the rows passed, not to
  // the middle of the pane.
  for (let step = 0; step < visibleRows + 1; step += 1) await page.keyboard.press('ArrowDown');
  const reached = row(`file-${String(visibleRows + 1).padStart(4, '0')}.txt`);
  await expect(reached).toHaveClass(/selected/);
  await expect(reached).toBeInViewport({ ratio: 1 });
  const afterWalk = await scrollTop();
  expect(afterWalk).toBeGreaterThan(0);
  expect(afterWalk).toBeLessThanOrEqual(3 * rowHeight);
});
