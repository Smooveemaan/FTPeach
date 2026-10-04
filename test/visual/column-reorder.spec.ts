import { expect, test } from '@playwright/test';

/* A swapped neighbour slides from where it stood, in either direction. The
   window turns RTL only after it first lays out, so a slide measured from that
   first layout started from the wrong side. */
for (const lang of ['en', 'ar'])
  test(`column swap slides the neighbour from its old place (${lang})`, async ({ page }) => {
    await page.goto(`/visual.html?lang=${lang}`);
    await expect(page.locator('html')).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
    await expect(page.locator('.pane-list').first()).toBeVisible();
    const headers = page.locator('.pane').first().locator('.row-header [data-column-key]');
    const [a, b] = [(await headers.nth(0).boundingBox())!, (await headers.nth(1).boundingBox())!];
    const key = await headers.nth(1).getAttribute('data-column-key');
    await page.evaluate((k) => {
      const w = window as unknown as { firstLeft?: number };
      const header = document.querySelector<HTMLElement>(`.pane [data-column-key="${k}"]`)!;
      new MutationObserver((_, observer) => {
        w.firstLeft = header.getBoundingClientRect().left;
        observer.disconnect();
      }).observe(header, { attributes: true, attributeFilter: ['style'] });
    }, key);
    const y = a.y + a.height / 2;
    await page.mouse.move(a.x + a.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + (b.x > a.x ? 20 : -20), y, { steps: 12 });
    await page.mouse.up();
    const firstLeft = await page.evaluate(
      () => (window as unknown as { firstLeft?: number }).firstLeft,
    );
    expect(Math.abs(firstLeft! - b.x)).toBeLessThan(1);
  });
