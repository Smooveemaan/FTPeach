import { expect, test } from '@playwright/test';

test('search input keeps native select, copy, paste and cut shortcuts', async ({
  page,
  context,
  browserName,
}) => {
  if (browserName === 'chromium')
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/test/visual/visual.html');
  const pane = page.locator('.pane').first();
  await pane.locator('.pane-search-toggle').click();
  const input = pane.locator('.pane-filter input');
  await input.fill('release');
  await input.press('End');
  await input.press('Control+a');
  await expect
    .poll(() =>
      input.evaluate((element: HTMLInputElement) =>
        element.value.slice(element.selectionStart ?? 0, element.selectionEnd ?? 0),
      ),
    )
    .toBe('release');
  await input.press('Control+c');
  await input.press('End');
  await input.press('Control+v');
  await expect(input).toHaveValue('releaserelease');
  await input.press('Control+a');
  await input.press('Control+x');
  await expect(input).toHaveValue('');
  await input.press('Control+v');
  await expect(input).toHaveValue('releaserelease');
  await expect(page.locator('html')).not.toHaveAttribute('data-keyboard-navigation');
});

test('Escape restores Help focus without enabling keyboard outlines', async ({ page }) => {
  await page.goto('/test/visual/visual.html');
  const help = page.getByRole('menuitem', { name: 'Help', exact: true });
  await help.click();
  await page.getByRole('menuitem', { name: /About/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(help).toBeFocused();
  await expect(help).toHaveCSS('outline-style', 'none');
  await expect(page.locator('html')).not.toHaveAttribute('data-keyboard-navigation');
});

test('only Tab starts focus cues, and pointer input ends them across dialogs', async ({ page }) => {
  await page.goto('/test/visual/visual.html');
  await page.getByRole('menuitem', { name: 'Help', exact: true }).click();
  await page.getByRole('menuitem', { name: /About/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const link = dialog.locator('.about-link').first();
  await link.focus();
  await page.keyboard.press('Delete');
  await expect(link).toHaveCSS('outline-style', 'none');
  await expect(page.locator('html')).not.toHaveAttribute('data-keyboard-navigation');

  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('html')).toHaveAttribute('data-keyboard-navigation', '');
  await expect(dialog.locator(':focus')).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Tab');
  await expect(dialog.locator(':focus')).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Escape');
  const help = page.getByRole('menuitem', { name: 'Help', exact: true });
  await expect(help).toBeFocused();
  await expect(help).toHaveCSS('outline-style', 'solid');

  await help.click();
  await expect(help).toHaveCSS('outline-style', 'none');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).not.toHaveAttribute('data-keyboard-navigation');
  await expect(help).toHaveCSS('outline-style', 'none');
});

test('a global shortcut waits while the recovered-edits prompt is open', async ({ page }) => {
  await page.goto('/test/visual/visual.html?recoveredEdits=1');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Control+,');
  // Give a dialog that should not open the time it would need to.
  await page.waitForTimeout(300);
  await expect(page.locator('.modal-settings')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(1);
});

for (const theme of ['dark', 'light'] as const) {
  test('menu keyboard focus is highlighted in ' + theme + ' mode', async ({ page }) => {
    await page.goto('/test/visual/visual.html');
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings…' }).click();
    await page.getByRole('button', { name: 'Interface', exact: true }).click();
    await page
      .getByRole('radio', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true })
      .click();
    const trigger = page.getByRole('button', { name: 'Color scheme', exact: true });
    await trigger.click();
    await page.mouse.move(1, 1);
    const options = page.getByRole('listbox', { name: 'Color scheme' }).getByRole('option');
    const hovered = options.nth(0);
    await hovered.hover();
    const highlight = await hovered.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(highlight).not.toBe('rgba(0, 0, 0, 0)');
    for (const [key, index] of [
      ['ArrowDown', 1],
      ['ArrowUp', 0],
      ['End', 19],
      ['Home', 0],
    ] as const) {
      await page.keyboard.press(key);
      await expect(options.nth(index)).toBeFocused();
      await expect(options.nth(index)).toHaveCSS('background-color', highlight);
      await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    }
    await page.mouse.move(1, 1);
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(0)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(options.nth(1)).toHaveCSS('background-color', highlight);
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    for (const key of ['Enter', 'Space']) {
      await trigger.click();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press(key);
      await expect(trigger).toBeFocused();
      await expect(page.getByRole('listbox', { name: 'Color scheme' })).toHaveCount(0);
    }
    await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'gray');
    await trigger.click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox', { name: 'Color scheme' })).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'gray');
  });
}

test('command menus highlight arrow focus after opening with the mouse', async ({ page }) => {
  await page.goto('/test/visual/visual.html');
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.mouse.move(1, 1);
  const items = page.locator('.menu-dropdown').getByRole('menuitem').filter({ visible: true });
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await expect(items.nth(1)).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(items.nth(0)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
});
