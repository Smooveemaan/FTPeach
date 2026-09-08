import { expect, test } from '@playwright/test';

for (const language of ['en', 'ru', 'ar']) {
  test(`settings carousel keeps edge items aligned (${language})`, async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 800 });
    await page.goto(`/visual.html?lang=${language}`);
    if (language === 'ar') await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await page.locator('.menu-bar-trigger').nth(1).click();
    await page.locator('.menu-dropdown .menu-item').first().click();
    await page.evaluate(() => document.fonts.ready);
    const nav = page.locator('.modal-settings.narrow .settings-nav');
    await expect(nav).toBeVisible();
    const arrows = nav.locator('.settings-nav-arrow');
    const items = nav.locator('.settings-nav-item');
    const viewport = nav.locator('.settings-nav-scroll');

    await viewport.hover();
    const track = nav.locator('.settings-nav-tabs');
    const initialTransform = await track.getAttribute('style');
    await page.mouse.wheel(0, 120);
    await expect(arrows.first()).toBeEnabled();
    await expect(track).not.toHaveAttribute('style', initialTransform!);
    await expect(items.first()).toHaveAttribute('aria-current', 'true');
    await page.mouse.wheel(0, -120);
    await expect(arrows.first()).toBeDisabled();
    await expect(track).toHaveAttribute('style', initialTransform!);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      for (const end of [1, 0]) {
        const arrow = arrows.nth(end);
        for (let step = 0; step < 10 && (await arrow.isEnabled()); step += 1) {
          await arrow.click();
        }
        await expect(arrow).toBeDisabled();
        const item = end ? items.last() : items.first();
        await expect
          .poll(async () => {
            const bounds = await viewport.boundingBox();
            const tab = await item.boundingBox();
            return (
              !!bounds &&
              !!tab &&
              tab.x >= bounds.x - 0.1 &&
              tab.x + tab.width <= bounds.x + bounds.width + 0.1
            );
          })
          .toBe(true);
        await item.click();
        await expect(item).toHaveAttribute('aria-current', 'true');
        // Browser focus/scroll requests must not compound the CSS transform.
        await item.evaluate((element) => element.scrollIntoView({ inline: 'nearest' }));
        await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBe(0);
      }
    }

    // Tab can reach clipped items, which must be revealed without selecting them.
    await items.first().focus();
    for (let index = 1; index < (await items.count()); index += 1) {
      await page.keyboard.press('Tab');
      await expect(items.nth(index)).toBeFocused();
      await expect
        .poll(async () => {
          const bounds = await viewport.boundingBox();
          const tab = await items.nth(index).boundingBox();
          return (
            !!bounds &&
            !!tab &&
            tab.x >= bounds.x - 0.1 &&
            tab.x + tab.width <= bounds.x + bounds.width + 0.1
          );
        })
        .toBe(true);
    }
    await expect(items.first()).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('Enter');
    await expect(items.last()).toHaveAttribute('aria-current', 'true');
    await expect(items.last()).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('.settings-panel input').first()).toBeFocused();

    // Activating an already selected category also enters its content on Tab.
    await items.last().focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(page.locator('.settings-panel input').first()).toBeFocused();

    // Reverse navigation still follows the category list.
    await items.last().focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+Tab');
    await expect(items.nth((await items.count()) - 2)).toBeFocused();

    // Returning from the desktop sidebar reveals the selected category.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.modal-settings')).not.toHaveClass(/narrow/);
    await expect(page.locator('.settings-nav-item').last()).toBeVisible();
    await page.setViewportSize({ width: 600, height: 800 });
    await expect(nav).toBeVisible();
    await expect(arrows.last()).toBeDisabled();
    await expect
      .poll(async () => {
        const bounds = await viewport.boundingBox();
        const tab = await items.last().boundingBox();
        return (
          !!bounds &&
          !!tab &&
          tab.x >= bounds.x - 0.1 &&
          tab.x + tab.width <= bounds.x + bounds.width + 0.1
        );
      })
      .toBe(true);
  });
}
