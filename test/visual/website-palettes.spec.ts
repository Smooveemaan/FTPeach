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

/** `routes` adds the test's own routes before the page opens; Playwright tries the latest route first. */
async function openSite(page: Page, routes?: () => Promise<unknown>) {
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
  await routes?.();
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
      // The appearance switch shows only the way to the other appearance.
      .locator('#themes [data-mode]:visible, #themes [data-palette-step], .palette-preview')
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

test('the header switch and the preview switch both change the whole site', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openSite(page);
  await page.getByRole('button', { name: 'Next color scheme' }).click();
  for (const appearance of ['light', 'dark'] as const) {
    const opposite = appearance === 'light' ? 'dark' : 'light';
    await page.getByRole('button', { name: 'Switch to ' + appearance + ' theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance);
    await expect(page.locator('.palette-preview > img').last()).toHaveAttribute(
      'src',
      'palettes/black-' + appearance + '.webp',
    );
    // The preview offers only the other appearance, as the header does.
    await expect(page.locator('.palette-modes [data-mode="' + appearance + '"]')).toBeHidden();
    await page.locator('.palette-modes [data-mode="' + opposite + '"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', opposite);
    await expect(page.locator('.palette-preview > img').last()).toHaveAttribute(
      'src',
      'palettes/black-' + opposite + '.webp',
    );
    await expect(
      page.getByRole('button', { name: 'Switch to ' + appearance + ' theme' }),
    ).toBeVisible();
    await page.locator('.palette-modes [data-mode="' + appearance + '"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance);
  }
  await expect(page.locator('#palette-name')).toHaveText('Onyx');
});

test('a slow earlier preview cannot overwrite the latest selection', async ({ page }) => {
  await openSite(page, () =>
    page.route('**/palettes/rose-dark.webp', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fallback();
    }),
  );
  await page.getByRole('button', { name: 'Previous color scheme' }).click();
  await page.getByRole('button', { name: 'Previous color scheme' }).click();
  await expect(page.locator('#palette-name')).toHaveText('Burgundy');
  await page.waitForTimeout(650);
  await expect(page.locator('#palette-name')).toHaveText('Burgundy');
  await expect(page.locator('.palette-preview > img')).toHaveCount(1);
});

test('a failed preview keeps the previous image and can be retried', async ({ page }) => {
  // Aborted from the start: the fetch ahead fails as well, and the click tries again.
  await openSite(page, () => page.route('**/palettes/rose-dark.webp', (route) => route.abort()));
  await page.getByRole('button', { name: 'Previous color scheme' }).click();
  await expect(page.locator('.palette-error')).toBeVisible();
  await expect(page.locator('#palette-name')).toHaveText('Peach');
  await page.unroute('**/palettes/rose-dark.webp');
  await page.getByRole('button', { name: 'Next color scheme' }).click();
  await page.getByRole('button', { name: 'Previous color scheme' }).click();
  await expect(page.locator('#palette-name')).toHaveText('Rose');
  await expect(page.locator('.palette-error')).toBeHidden();
});

test('only the shown preview, its neighbours and its other appearance are fetched ahead', async ({
  page,
}) => {
  const requested = new Set<string>();
  page.on('request', (request) => {
    if (request.url().includes('/palettes/') && request.url().endsWith('.webp'))
      requested.add(new URL(request.url()).pathname.slice('/palettes/'.length));
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await openSite(page);
  await expect
    .poll(() => [...requested].sort())
    .toEqual(['black-dark.webp', 'peach-dark.webp', 'peach-light.webp', 'rose-dark.webp']);
  await page.getByRole('button', { name: 'Previous color scheme' }).click();
  await expect(page.locator('#palette-name')).toHaveText('Rose');
  await expect.poll(() => requested.has('burgundy-dark.webp')).toBe(true);
  expect(requested.size).toBe(6);
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
    // The appearance switch changes the whole site at once; only the scheme cross-fades.
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await expect(page.locator('.palette-modes [data-mode="light"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Next color scheme' }).click();
    await expect(page.locator('#palette-name')).toHaveText('Onyx');
    await expect(page.locator('.palette-preview > img')).toHaveCount(1);
    expect(await page.evaluate(() => Reflect.get(window, 'paletteTimings'))).toEqual(
      reducedMotion === 'reduce' ? [] : [320],
    );
  });
}

test('homepage sections keep their address and browser history, the other screenshot waiting for the load', async ({
  page,
}) => {
  const images: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'image') images.push(request.url());
  });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.addInitScript(() => localStorage.setItem('theme', 'light'));
  await openSite(page);
  const header = page.locator('.site-header .jump');
  await header.locator('a[href="#features"]').click();
  await expect(page).toHaveURL('https://preview.test/#features');
  await expect(page.locator('#features')).toBeFocused();
  await header.locator('a[href="#protocols"]').click();
  await expect(page).toHaveURL('https://preview.test/#protocols');
  await header.locator('a[href="#protocols"]').click();
  await page.goBack();
  await expect(page).toHaveURL('https://preview.test/#features');
  await page.goForward();
  await expect(page).toHaveURL('https://preview.test/#protocols');
  await expect(page.getByRole('link', { name: 'All the details' })).toHaveAttribute(
    'href',
    'guide/protocol-reference.html',
  );
  expect(images.some((url) => url.endsWith('/ftpeach-light.png'))).toBe(true);
  // The dark screenshot is fetched ahead for a switch, only once the page has loaded.
  const timing = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const dark = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.endsWith('/ftpeach-dark.png'));
    return { load: navigation.loadEventStart, dark: dark?.startTime };
  });
  expect(timing.dark).toBeGreaterThanOrEqual(timing.load);
});

test('a theme switch after the load downloads nothing and fades the page as one', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openSite(page);
  await page.waitForLoadState('load');
  // Everything the switch needs is fetched ahead; wait until it has been.
  await expect
    .poll(() =>
      page.evaluate(() =>
        ['/ftpeach-light.png', '/palettes/peach-light.webp'].every((name) =>
          performance.getEntriesByType('resource').some((entry) => entry.name.endsWith(name)),
        ),
      ),
    )
    .toBe(true);
  const late: string[] = [];
  page.on('request', (request) => late.push(request.url()));
  const during = await page.evaluate(() => {
    document.getElementById('theme')!.click();
    const button = document.querySelector('.choice .btn')!;
    return {
      switching: document.documentElement.classList.contains('theme-switch'),
      transition: getComputedStyle(button).transitionDuration,
    };
  });
  expect(during).toEqual({ switching: true, transition: '0s' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.palette-preview > img').last()).toHaveAttribute(
    'src',
    'palettes/peach-light.webp',
  );
  await expect(page.locator('html')).not.toHaveClass(/theme-switch/);
  // After the switch only the next pictures ahead are fetched: the neighbours in the light appearance.
  expect(late.map((url) => new URL(url).pathname).sort()).toEqual([
    '/palettes/black-light.webp',
    '/palettes/rose-light.webp',
  ]);
});

test('a theme switch before the other screenshot arrives waits for it only briefly', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  // Never answered: a phone on a slow network that clicks before the picture came.
  await openSite(page, () => page.route('**/ftpeach-light.png', () => {}));
  const took = await page.evaluate(async () => {
    const started = performance.now();
    document.getElementById('theme')!.click();
    while (document.documentElement.classList.contains('theme-switch'))
      await new Promise(requestAnimationFrame);
    return performance.now() - started;
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  // Half a second of waiting and the fade, far from the 4 s Chrome holds a transition.
  expect(took).toBeLessThan(1500);
});

test('the header reaches every page at every width and reduced motion skips scrolling and fades', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openSite(page);
  const header = page.locator('.site-header');
  for (const width of [
    320, 359, 390, 479, 480, 599, 600, 768, 860, 979, 980, 1024, 1040, 1041, 1150, 1440,
  ]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => scrollTo(0, 0));
    // Wide screens show the page links in the bar; narrow ones fold them into the menu.
    const links = width > 1040 ? header.locator('.nav') : header.locator('.menu');
    if (width <= 1040) await header.getByRole('button', { name: 'Menu' }).click();
    for (const name of ['User guide', 'Compare']) {
      const link = links.getByRole('link', { name });
      await expect(link).toBeVisible();
      const box = (await link.boundingBox())!;
      expect(box.x + box.width, `${name} at ${width}px`).toBeLessThanOrEqual(width);
    }
    if (width <= 1040) {
      await page.keyboard.press('Escape');
      await expect(header.locator('.menu')).toBeHidden();
    }
    const bar = await header
      .locator('.top > .wrap, :scope > .wrap')
      .first()
      .evaluate((wrap) =>
        [...wrap.children]
          .map((child) => child.getBoundingClientRect())
          .filter((box) => box.width > 0)
          .map((box) => ({ left: box.left, right: box.right })),
      );
    for (const [index, box] of bar.entries()) {
      expect(box.left, `header item at ${width}px`).toBeGreaterThanOrEqual(0);
      expect(box.right, `header item at ${width}px`).toBeLessThanOrEqual(width);
      for (const other of bar.slice(index + 1))
        expect(box.right <= other.left || other.right <= box.left).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
  await expect(page.locator('h1')).toHaveCSS('animation-name', 'none');
  const scroll = await page.evaluate(() => {
    (document.querySelector('.site-header .jump a[href="#download"]') as HTMLElement).click();
    return scrollY;
  });
  expect(scroll).toBeGreaterThan(0);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(errors).toEqual([]);
});

test('after a reload the page stays where it was read', async ({ page }) => {
  await openSite(page);
  await page.evaluate(() => scrollTo({ top: 2400, behavior: 'instant' }));
  await page.reload();
  expect(await page.evaluate(() => Math.round(scrollY))).toBe(2400);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => Math.round(scrollY))).toBe(2400);
});
