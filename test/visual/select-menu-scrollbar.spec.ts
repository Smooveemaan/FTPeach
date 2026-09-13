import { expect, test } from '@playwright/test';

// Headless Chromium hides scrollbars by default, which would skip the very
// strip this test has to grab.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

for (const language of ['en', 'he']) {
  test(`settings language menu scrollbar can be dragged (${language})`, async ({ page }) => {
    await page.goto(`/visual.html?lang=${language}`);
    await page.locator('.menu-bar-trigger').nth(1).click();
    await page.locator('.menu-dropdown .menu-item').first().click();
    await page.locator('.settings-nav-item').nth(2).click();
    await page.locator('div[class="language-select"] > .language-select-trigger').click();

    const dropdown = page.locator('.language-select-dropdown:not(.select-menu-sizer)');
    await expect(dropdown).toBeVisible();
    const grip = await dropdown.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const rtl = getComputedStyle(element).direction === 'rtl';
      const x = rtl ? bounds.left + 5 : bounds.right - 5;
      const y = bounds.top + 20;
      return { x, y, hitsDropdown: document.elementFromPoint(x, y) === element };
    });
    expect(grip.hitsDropdown).toBe(true);

    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(grip.x, grip.y + 60, { steps: 6 });
    await page.mouse.up();

    await expect(dropdown).toBeVisible();
    expect(await dropdown.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  });
}
