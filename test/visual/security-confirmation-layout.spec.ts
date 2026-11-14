import { expect, test } from '@playwright/test';

for (const prompt of ['useSystemProtection', 'revealSiteSecret']) {
  test(`security confirmation fits ${prompt} without retaining the initial window height`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 460, height: 600 });
    let resizes = 0;
    await page.exposeFunction('visualSetSize', async (size: { width: number; height: number }) => {
      await page.setViewportSize({
        width: Math.round(size.width),
        height: Math.round(size.height),
      });
      resizes += 1;
    });
    await page.goto(`/test/visual/visual.html?security=${prompt}&lang=en`);
    await expect.poll(() => resizes).toBe(2);
    const layout = await page.locator('.security-confirmation').evaluate((modal) => {
      const content = modal.querySelector<HTMLElement>('.modal-body')!;
      const last = content.lastElementChild!.getBoundingClientRect();
      const footer = modal.querySelector('.modal-footer')!.getBoundingClientRect();
      return {
        height: modal.getBoundingClientRect().height,
        gap: footer.top - last.bottom,
        contentFits: content.scrollHeight <= content.clientHeight,
      };
    });
    expect(layout.height).toBeLessThan(300);
    expect(layout.gap).toBeGreaterThanOrEqual(13);
    expect(layout.gap).toBeLessThan(45);
    expect(layout.contentFits).toBe(true);
    if (prompt === 'revealSiteSecret')
      await expect(page.locator('input[type=password]')).toBeVisible();
    else await expect(page.locator('input')).toHaveCount(0);
  });
}

test('native confirmation dims the settings dialog until it closes', async ({ page }) => {
  await page.goto('/test/visual/visual.html');
  await page.locator('.view-toolbar-settings').click();
  const settings = page.getByRole('dialog');
  await expect(settings).toBeVisible();
  await page.evaluate(() => document.body.classList.add('native-confirmation-visible'));
  const scrim = await page.evaluate(() => {
    const style = getComputedStyle(document.body, '::after');
    return {
      content: style.content,
      background: style.backgroundColor,
      zIndex: Number(style.zIndex),
    };
  });
  expect(scrim.content).toBe('""');
  expect(scrim.background).toBe('rgba(0, 0, 0, 0.45)');
  expect(scrim.zIndex).toBeGreaterThan(
    Number(await settings.evaluate((el) => getComputedStyle(el.parentElement!).zIndex)),
  );
  await page.evaluate(() => document.body.classList.remove('native-confirmation-visible'));
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body, '::after').content))
    .toBe('none');
});
