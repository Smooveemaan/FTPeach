import { expect, test } from '@playwright/test';

for (const theme of ['dark', 'light']) {
  test(`primary button has contrasting keyboard focus in ${theme} theme`, async ({ page }) => {
    await page.goto('/visual.html');
    await page
      .locator('html')
      .evaluate((element, value) => element.setAttribute('data-theme', value), theme);
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings…' }).click();
    const footer = page.locator('.settings-nav-footer');
    const save = footer.locator('.btn-primary');
    await footer.locator('.btn').first().focus();
    await page.keyboard.press('Tab');
    await expect(save).toBeFocused();
    await expect(save).toHaveCSS('outline-style', 'solid');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(save).toHaveCSS('outline-offset', '2px');
    await expect(save).toHaveCSS(
      'outline-color',
      theme === 'dark' ? 'rgb(255, 157, 114)' : 'rgb(232, 120, 82)',
    );
    await page.locator('.modal-header').click();
    await save.focus();
    await expect(save).toHaveCSS('outline-style', 'none');
  });
}
