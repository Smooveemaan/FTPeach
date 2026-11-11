import { expect, test } from '@playwright/test';
test('real pointer reaches address segments during a file drag', async ({ page }) => {
  await page.goto('/test/visual/visual.html');
  const pane = page.locator('.pane').first();
  const row = pane.locator('.row[data-name="release-notes.md"] .name');
  await expect(row).toBeVisible();
  const crumb = pane.locator('[data-drop-path]').first();
  const from = (await row.boundingBox())!;
  const to = (await crumb.boundingBox())!;
  await page.mouse.move(from.x + Math.min(20, from.width / 2), from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await expect(crumb).toHaveClass(/drag-target/);
  await expect(page.locator('.drag-move-ghost.active')).toContainText('Move');
  await expect(page.locator('.drag-move-ghost.active')).toContainText('release-notes.md');
  await expect(page.locator('.drag-move-ghost.active .icon svg')).toBeVisible();
  const copyKey = await page.evaluate(() =>
    /Macintosh|Mac OS X/i.test(navigator.userAgent) ? 'Alt' : 'Control',
  );
  await page.keyboard.down(copyKey);
  await expect(page.locator('.drag-move-ghost.active')).toContainText('Copy');
  await page.keyboard.down('Shift');
  await expect(page.locator('body')).toHaveClass(/drag-drop-forbidden/);
  await expect(crumb).toHaveCSS('cursor', 'not-allowed');
  await expect(page.locator('.drag-move-ghost.active')).toHaveCount(0);
  await page.keyboard.up('Shift');
  await expect(page.locator('.drag-move-ghost.active')).toContainText('Copy');
  await page.mouse.up();
  await page.keyboard.up(copyKey);
  await expect(crumb).not.toHaveClass(/drag-target/);
});

test('dragging a file across the log does not select its text', async ({ page }) => {
  await page.goto('/test/visual/visual.html?log=1');
  await page.getByRole('button', { name: 'Show/hide log', exact: true }).click();
  const row = page.locator('.pane[data-side="a"] .row[data-name="release-notes.md"] .name');
  const log = page.locator('.log-panel-body');
  await expect(row).toBeVisible();
  await expect(log).toHaveCSS('user-select', 'text');
  const from = (await row.boundingBox())!;
  const to = (await log.boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 30, to.y + 10, { steps: 12 });
  await expect(page.locator('body')).toHaveClass(/drag-move-active/);
  await expect(log).toHaveCSS('user-select', 'none');
  await page.mouse.move(to.x + Math.min(400, to.width - 20), to.y + to.height - 10, {
    steps: 12,
  });
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  await page.mouse.up();
  await expect(page.locator('body')).not.toHaveClass(/drag-move-active/);
  await expect(log).toHaveCSS('user-select', 'text');
});

test('text selection stays disabled while an outbound native drag is pending', async ({ page }) => {
  await page.goto('/test/visual/visual.html?log=1');
  await page.getByRole('button', { name: 'Show/hide log', exact: true }).click();
  await page.evaluate(() => {
    window.api.dragOut.startLocal = () =>
      new Promise((resolve) => {
        document.addEventListener('test-native-drag-ended', () => resolve({ ok: true }), {
          once: true,
        });
      });
  });
  const row = page.locator('.pane[data-side="a"] .row[data-name="release-notes.md"] .name');
  const log = page.locator('.log-panel-body');
  const from = (await row.boundingBox())!;
  const to = (await log.boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 30, to.y + 10, { steps: 12 });
  await page.evaluate(() =>
    document.dispatchEvent(
      new MouseEvent('mousemove', {
        clientX: 30,
        clientY: window.innerHeight + 1,
        buttons: 1,
        bubbles: true,
      }),
    ),
  );
  await expect(page.locator('body')).toHaveClass(/native-drag-active/);
  await expect(log).toHaveCSS('user-select', 'none');
  await page.mouse.move(to.x + 400, to.y + to.height - 10, { steps: 12 });
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  await page.mouse.up();
  await expect(log).toHaveCSS('user-select', 'none');
  await page.evaluate(() => document.dispatchEvent(new Event('test-native-drag-ended')));
  await expect(page.locator('body')).not.toHaveClass(/native-drag-active/);
  await expect(log).toHaveCSS('user-select', 'text');
});
