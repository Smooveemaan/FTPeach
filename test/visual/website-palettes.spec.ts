import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fillPage } from '../../scripts/site/build.ts';
import { COLOR_SCHEMES } from '../../src/shared/appearance.ts';

const root = path.resolve(import.meta.dirname, '../..');
const html = fillPage(
  await readFile(path.join(root, 'site/index.html'), 'utf8'),
  {
    tag_name: 'v0.4.0',
    assets: [
      {
        name: 'FTPeach_0.4.0_x64-setup.exe',
        browser_download_url: 'https://example.com/setup.exe',
      },
    ],
  },
  { stars: 10, downloads: 0 },
);

async function openSite(page: Page) {
  await page.route('https://preview.test/**', async (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    const file =
      name === 'palettes.js' ||
      name === 'theme-init.js' ||
      name === 'styles.css' ||
      name.startsWith('fonts/')
        ? 'site/' + name
        : name === 'favicon.ico'
          ? 'public/favicon.ico'
          : 'assets/images/' + name;
    const type = name.endsWith('.js')
      ? 'text/javascript'
      : name.endsWith('.css')
        ? 'text/css'
        : name.endsWith('.woff2')
          ? 'font/woff2'
          : name.endsWith('.webp')
            ? 'image/webp'
            : 'image/png';
    await route.fulfill(
      name === ''
        ? { contentType: 'text/html', body: html }
        : { contentType: type, body: await readFile(path.join(root, file)) },
    );
  });
  await page.goto('https://preview.test/');
  await page.locator('#themes').scrollIntoViewIfNeeded();
  await expect(page.locator('.palette-preview > img')).toBeVisible();
}

for (const width of [320, 390, 768, 1440]) {
  test(`palette controls fit at ${width}px and work with keyboard`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await openSite(page);
    await expect(page.locator('.palette-options')).toHaveCount(0);
    const bounds = await page
      .locator('#themes [data-mode], #themes [data-palette-step], .palette-preview')
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const r = node.getBoundingClientRect();
          return { left: r.left, right: r.right, height: r.height };
        }),
      );
    for (const r of bounds) {
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.right).toBeLessThanOrEqual(width);
      expect(r.height).toBeGreaterThanOrEqual(44);
    }
    const rose = page.getByRole('button', { name: 'Previous color scheme' });
    await rose.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('#palette-name')).toHaveText('Rose');
    await expect(page.locator('.palette-preview > img')).toHaveCount(1);
    await page.locator('#themes').screenshot({ path: info.outputPath('themes.png') });
  });
}

for (const mode of ['dark', 'light'] as const) {
  test(`all palette previews load in ${mode}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: mode, reducedMotion: 'reduce' });
    await openSite(page);
    for (const [index, id] of COLOR_SCHEMES.entries()) {
      if (index > 0) await page.getByRole('button', { name: 'Next color scheme' }).click();
      await expect(page.locator('.palette-preview > img').last()).toHaveAttribute(
        'src',
        `palettes/${id}-${mode}.webp`,
      );
      expect(
        await page
          .locator('.palette-preview > img')
          .last()
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      ).toBeGreaterThan(2000);
    }
  });
}

test('header controls both modes while preview controls only its own mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openSite(page);
  await page.getByRole('button', { name: 'Next color scheme' }).click();
  for (const appearance of ['light', 'dark']) {
    await page.getByRole('button', { name: 'Switch to ' + appearance + ' theme' }).click();
    await expect(page.locator('.palette-modes [data-mode="' + appearance + '"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('.palette-preview > img').last()).toHaveAttribute(
      'src',
      'palettes/black-' + appearance + '.webp',
    );
    const opposite = appearance === 'light' ? 'dark' : 'light';
    await page.locator('.palette-modes [data-mode="' + opposite + '"]').click();
    await expect(page.locator('.palette-modes [data-mode="' + opposite + '"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance);
    await expect(
      page.getByRole('button', { name: 'Switch to ' + opposite + ' theme' }),
    ).toBeVisible();
    await page.locator('.palette-modes [data-mode="' + appearance + '"]').click();
    await expect(page.locator('.palette-modes [data-mode="' + appearance + '"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  }
  await expect(page.locator('#palette-name')).toHaveText('Onyx');
});

test('a slow earlier preview cannot overwrite the latest selection', async ({ page }) => {
  await openSite(page);
  await page.route('**/palettes/rose-dark.webp', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fallback();
  });
  await page.getByRole('button', { name: 'Previous color scheme' }).click();
  await page.getByRole('button', { name: 'Previous color scheme' }).click();
  await expect(page.locator('#palette-name')).toHaveText('Burgundy');
  await page.waitForTimeout(650);
  await expect(page.locator('#palette-name')).toHaveText('Burgundy');
  await expect(page.locator('.palette-preview > img')).toHaveCount(1);
});

test('a failed preview keeps the previous image and can be retried', async ({ page }) => {
  await openSite(page);
  await page.route('**/palettes/rose-dark.webp', (route) => route.abort());
  await page.getByRole('button', { name: 'Previous color scheme' }).click();
  await expect(page.locator('.palette-error')).toBeVisible();
  await expect(page.locator('#palette-name')).toHaveText('Peach');
  await page.unroute('**/palettes/rose-dark.webp');
  await page.getByRole('button', { name: 'Next color scheme' }).click();
  await page.getByRole('button', { name: 'Previous color scheme' }).click();
  await expect(page.locator('#palette-name')).toHaveText('Rose');
  await expect(page.locator('.palette-error')).toBeHidden();
});

test('palette previews are loaded on demand', async ({ page }) => {
  const requested = new Set<string>();
  page.on('request', (request) => {
    if (request.url().includes('/palettes/') && request.url().endsWith('.webp'))
      requested.add(request.url());
  });
  await openSite(page);
  expect([...requested].every((url) => url.includes('/peach-'))).toBe(true);
  await page.getByRole('button', { name: 'Previous color scheme' }).click();
  await expect(page.locator('#palette-name')).toHaveText('Rose');
  expect([...requested].every((url) => /\/(peach|rose)-/.test(url))).toBe(true);
});

test.describe('touch preview', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('a phone can select a palette and its light appearance', async ({ page }, info) => {
    await openSite(page);
    await page.getByRole('button', { name: 'Previous color scheme' }).tap();
    await expect(page.locator('#palette-name')).toHaveText('Rose');
    await page.getByRole('button', { name: 'Light', exact: true }).tap();
    await expect(page.locator('.palette-preview > img').last()).toHaveAttribute(
      'src',
      /rose-light\.webp$/,
    );
    await expect(page.locator('.palette-preview')).not.toHaveAttribute('href');
    await expect(page.locator('.palette-help')).toHaveCount(0);
    await expect(page.locator('.palette-preview > img')).toHaveCount(1);
    await page.locator('#themes').screenshot({
      path: info.outputPath('phone-light.png'),
      style: '.site-header { visibility: hidden; }',
    });
  });
});

test('palette arrows wrap around in both directions', async ({ page }) => {
  await openSite(page);
  const previous = page.getByRole('button', { name: 'Previous color scheme' });
  const next = page.getByRole('button', { name: 'Next color scheme' });
  await previous.click();
  await expect(page.locator('#palette-name')).toHaveText('Rose');
  await next.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#palette-name')).toHaveText('Peach');
  await page.getByRole('button', { name: 'Previous color scheme' }).click();
  await expect(page.locator('#palette-name')).toHaveText('Rose');
  await next.click();
  await expect(page.locator('#palette-name')).toHaveText('Peach');
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test('palette and mode cross-fades work with ' + reducedMotion, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await openSite(page);
    await expect(page.locator('.palette-preview > img')).toHaveCount(1);
    await page.evaluate(() => {
      const timings: number[] = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (frames, options) {
        if (this.parentElement?.classList.contains('palette-preview'))
          timings.push(Number(typeof options === 'number' ? options : options?.duration));
        return animate.call(this, frames, options);
      };
      Object.assign(window, { paletteTimings: timings });
    });
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await expect(page.locator('.palette-modes [data-mode="light"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Next color scheme' }).click();
    await expect(page.locator('#palette-name')).toHaveText('Onyx');
    await expect(page.locator('.palette-preview > img')).toHaveCount(1);
    expect(await page.evaluate(() => Reflect.get(window, 'paletteTimings'))).toEqual([450, 450]);
  });
}

test('header transition waits for the preview and does not start a second fade', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openSite(page);
  await expect(page.locator('.palette-preview > img')).toHaveCount(1);
  await page.route('**/palettes/peach-light.webp', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fallback();
  });
  await page.evaluate(() => {
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = (change) =>
      start(async () => {
        if (typeof change === 'function') await change();
        const image = document.querySelector('.palette-preview > img:last-child');
        Object.assign(window, {
          previewAtTransition: {
            src: image?.getAttribute('src'),
            animations: image?.getAnimations().length,
          },
        });
      });
  });
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'previewAtTransition')))
    .toEqual({
      src: 'palettes/peach-light.webp',
      animations: 0,
    });
});
