import { expect, test } from '@playwright/test';

test('settings lists scroll one row at a time in both directions and retain their inset', async ({
  page,
}) => {
  await page.goto('/test/visual/visual.html');
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Settings…' }).click();
  await page.getByRole('button', { name: 'Interface', exact: true }).click();
  const triggers = page.locator('.modal-settings .language-select > button:enabled');
  expect(await triggers.count()).toBeGreaterThanOrEqual(4);
  for (let menu = 0; menu < (await triggers.count()); menu++) {
    const trigger = triggers.nth(menu);
    await trigger.click();
    await page.mouse.move(1, 1);
    const list = page.locator('.modal-settings').getByRole('listbox');
    const count = await list.getByRole('option').count();
    await page.keyboard.press('Home');
    const geometry = () =>
      list.evaluate((element) => {
        const row = document.activeElement!.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        const frame = element.parentElement!.getBoundingClientRect();
        return {
          scroll: element.scrollTop,
          rowHeight: row.height,
          top: row.top - box.top,
          bottom: box.bottom - row.bottom,
          insetTop: box.top - frame.top,
          insetBottom: frame.bottom - box.bottom,
          pageY: window.scrollY,
        };
      });
    let previous = await geometry();
    for (const key of ['ArrowDown', 'ArrowUp']) {
      for (let step = 1; step < count; step++) {
        await page.keyboard.press(key);
        const current = await geometry();
        expect(current.top).toBeGreaterThanOrEqual(-1);
        expect(current.bottom).toBeGreaterThanOrEqual(-1);
        expect(current.insetTop).toBeGreaterThanOrEqual(4);
        expect(current.insetBottom).toBeGreaterThanOrEqual(4);
        expect(Math.abs(current.scroll - previous.scroll)).toBeLessThanOrEqual(
          current.rowHeight + 1,
        );
        expect(current.pageY).toBe(previous.pageY);
        previous = current;
      }
    }
    await page.keyboard.press('End');
    await expect(list.getByRole('option').last()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(list.getByRole('option').first()).toBeFocused();
    await trigger.click();
  }
});

test('short protocol menus keep arrow navigation and wrapping', async ({ page }) => {
  await page.goto('/test/visual/visual.html');
  await page.getByRole('menuitem', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Disconnect', exact: true }).click();
  await page.locator('.protocol-select-trigger').first().click();
  const options = page.locator('.protocol-select-dropdown').getByRole('option');
  await page.keyboard.press('End');
  await expect(options.last()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(options.first()).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(options.last()).toBeFocused();
});
test('command menu scrolls only enough to reveal the focused row', async ({ page }) => {
  await page.goto('/test/visual/visual.html');
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  const menu = page.locator('.menu-dropdown .menu-items');
  await menu.evaluate((element) => {
    element.style.maxHeight = '32px';
    element.style.overflowY = 'auto';
  });
  await page.mouse.move(1, 1);
  await page.keyboard.press('Home');
  for (const key of ['ArrowDown', 'ArrowUp']) {
    await page.keyboard.press(key);
    const position = await menu.evaluate((element) => {
      const row = document.activeElement!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return { top: row.top - box.top, bottom: box.bottom - row.bottom };
    });
    expect(position.top).toBeGreaterThanOrEqual(-1);
    expect(position.bottom).toBeGreaterThanOrEqual(-1);
  }
});
