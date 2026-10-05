import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// 500 rows is well past the virtualization threshold, so only the rows on
// screen are in the DOM while the rectangle covers far more of them.
async function openLongList(page: Page) {
  await page.goto('/visual.html?manyFiles=500');
  const list = page.locator('.pane-list[data-side="a"]');
  const first = list.locator('.row[data-name="file-0000.txt"]');
  await expect(first).toBeVisible();
  const row = (await first.boundingBox())!;
  const box = (await list.boundingBox())!;
  // The rectangle has to start on empty list space beside the rows.
  expect(box.x + box.width - (row.x + row.width)).toBeGreaterThan(40);
  return { list, row, box, startX: row.x + row.width + 20 };
}

const selectedCount = (page: Page) =>
  page
    .locator('.status-bar')
    .getByText(/\(\d+ selected\)/)
    .first();

test('shrinking the rectangle after scrolling away keeps only the rows still inside it', async ({
  page,
}) => {
  const { list, row, box, startX } = await openLongList(page);
  const top = row.y + 2;
  await page.mouse.move(startX, top);
  await page.mouse.down();
  await page.mouse.move(row.x + 40, top + 3 * row.height, { steps: 5 });
  await expect(selectedCount(page)).toHaveText(/\(4 selected\)/);

  // Jump far down, as the wheel or the scroll bar can while dragging: the
  // rows passed over were never mounted, yet all of them are in the rectangle.
  await list.evaluate((el) => {
    el.scrollTop = 4000;
  });
  await page.mouse.move(row.x + 40, box.y + box.height / 2, { steps: 2 });
  const passed = Math.floor((box.y + box.height / 2 - top + 4000) / row.height) + 1;
  await expect(selectedCount(page)).toHaveText(
    new RegExp(`\\((${passed - 1}|${passed}|${passed + 1}) selected\\)`),
  );

  // Jump back and shrink the rectangle: the rows it left while they were
  // not mounted must not stay selected.
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.mouse.move(row.x + 40, top + 3 * row.height, { steps: 2 });
  await expect(selectedCount(page)).toHaveText(/\(4 selected\)/);
  await page.mouse.up();

  // Scrolling to the edges while dragging still works.
  await page.mouse.move(startX, top);
  await page.mouse.down();
  await page.mouse.move(row.x + 40, box.y + box.height - 4, { steps: 5 });
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(500);
  await page.mouse.up();
});

test('Ctrl+drag adds to the selection and shrinking it gives the old selection back', async ({
  page,
}) => {
  const { list, row, startX } = await openLongList(page);
  await list.locator('.row[data-name="file-0006.txt"]').click();
  await expect(selectedCount(page)).toHaveText(/\(1 selected\)/);

  const top = row.y + 2;
  await page.keyboard.down('Control');
  await page.mouse.move(startX, top);
  await page.mouse.down();
  await page.mouse.move(row.x + 40, top + 2 * row.height, { steps: 5 });
  await expect(selectedCount(page)).toHaveText(/\(4 selected\)/);
  await page.mouse.move(row.x + 40, top + row.height / 2, { steps: 5 });
  await expect(selectedCount(page)).toHaveText(/\(2 selected\)/);
  await page.mouse.up();
  await page.keyboard.up('Control');
  await expect(list.locator('.row[data-name="file-0006.txt"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('Shift+click after sorting extends from the file clicked, not from its old position', async ({
  page,
}) => {
  const { list } = await openLongList(page);
  await list.locator('.row[data-name="file-0002.txt"]').click();
  // Sort by name the other way round: file-0002 moves to the far end.
  // The default name order is implicit, so it may take a click to make it
  // explicit before the next one reverses it.
  const nameHeader = page.locator('.pane').first().locator('.row-header .col-header').first();
  const firstRow = list.locator('.row[data-index]').first();
  await expect(async () => {
    await nameHeader.click();
    await expect(firstRow).toHaveAttribute('data-name', 'file-0499.txt', { timeout: 500 });
  }).toPass();
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await list.locator('.row[data-name="file-0005.txt"]').click({ modifiers: ['Shift'] });
  await expect(selectedCount(page)).toHaveText(/\(4 selected\)/);
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`marquee geometry follows each pointer move immediately with motion ${reducedMotion}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    const { list, box, startX } = await openLongList(page);
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // Activate the rectangle before reversing direction. Read in the event's
    // frame: waiting for a locator assertion would hide a CSS transition.
    await page.mouse.move(startX - 80, startY - 60);
    const samples = await list.evaluate(
      (el, { startX, startY }) => {
        const marquee = el.closest('.pane')!.querySelector('.marquee-select')!;
        const clip = el.getBoundingClientRect();
        return [
          { x: clip.right + 40, y: startY + 60 },
          { x: clip.left - 40, y: startY - 60 },
          { x: startX + 10, y: startY + 20 },
        ].map(({ x, y }) => {
          el.dispatchEvent(
            new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }),
          );
          const rect = marquee.getBoundingClientRect();
          return {
            actual: [rect.left, rect.top, rect.right, rect.bottom],
            expected: [
              Math.max(clip.left, Math.min(startX, x)),
              Math.max(clip.top, Math.min(startY, y)),
              Math.min(clip.right, Math.max(startX, x)),
              Math.min(clip.bottom, Math.max(startY, y)),
            ],
            animations: marquee.getAnimations().length,
            // Which sides lost their border because the list cut them off.
            cut: (['Left', 'Right', 'Top', 'Bottom'] as const).filter(
              (side) => getComputedStyle(marquee)[`border${side}Color`] === 'rgba(0, 0, 0, 0)',
            ),
          };
        });
      },
      { startX, startY },
    );
    await page.mouse.up();
    expect(samples.map((sample) => sample.cut)).toEqual([['Right'], ['Left'], []]);
    for (const sample of samples) {
      expect(sample.animations).toBe(0);
      sample.actual.forEach((edge, i) => {
        expect(Math.abs(edge - sample.expected[i]!)).toBeLessThan(0.1);
      });
    }
  });
}

test('a rectangle swept fast past the edge never shows the list blank', async ({ page }) => {
  const { list, row, box, startX } = await openLongList(page);
  await page.mouse.move(startX, row.y + 2);
  await page.mouse.down();
  // Far below the list: the fastest the rectangle scrolls it.
  await page.mouse.move(startX, box.y + box.height + 400, { steps: 5 });
  // Every frame, the rows on screen reach from the list's top to its bottom.
  const gaps = await list.evaluate(
    (el) =>
      new Promise<string[]>((resolve) => {
        const found: string[] = [];
        let frames = 0;
        const check = () => {
          const top = el.getBoundingClientRect().top;
          const bottom = top + el.clientHeight;
          const rows = [...el.querySelectorAll('.row[data-index]')].map((row) =>
            row.getBoundingClientRect(),
          );
          const covers = (y: number) => rows.some((rect) => rect.top <= y && rect.bottom >= y);
          if (!covers(top + 1) || !covers(bottom - 1))
            found.push(`frame ${frames} at ${el.scrollTop}`);
          if (++frames < 30) requestAnimationFrame(check);
          else resolve(found);
        };
        requestAnimationFrame(check);
      }),
  );
  await page.mouse.up();
  expect(gaps).toEqual([]);
});
