import { expect, test } from '@playwright/test';

test('search input keeps native select, copy, paste and cut shortcuts', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/visual.html');
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
  await page.goto('/visual.html');
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
  await page.goto('/visual.html');
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
