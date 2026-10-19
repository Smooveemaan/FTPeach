import { expect, test, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildGuide, GUIDE_PAGES } from '../../scripts/site/guide.ts';

const root = path.resolve(import.meta.dirname, '../..');
let output: string;

test.beforeAll(async () => {
  output = await mkdtemp(path.join(os.tmpdir(), 'ftpeach-guide-browser-'));
  await buildGuide(root, output);
});
test.afterAll(async () => {
  await rm(output, { recursive: true, force: true });
});

async function serveGuide(page: Page) {
  await page.route('https://guide.test/**', async (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    const file =
      name.startsWith('guide/') || name.startsWith('images/guide/')
        ? path.join(output, name)
        : name === 'icon.png'
          ? path.join(root, 'assets/images/icon.png')
          : name === 'favicon.ico'
            ? path.join(root, 'public/favicon.ico')
            : path.join(root, 'site', name);
    const contentType = name.endsWith('.html')
      ? 'text/html'
      : name.endsWith('.css')
        ? 'text/css'
        : name.endsWith('.js')
          ? 'text/javascript'
          : name.endsWith('.woff2')
            ? 'font/woff2'
            : 'image/png';
    await route.fulfill({ contentType, body: await readFile(file) });
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  for (const width of [320, 768, 1440]) {
    test.describe(`${colorScheme}, ${width}px, without JavaScript`, () => {
      test.use({ colorScheme, javaScriptEnabled: false, viewport: { width, height: 900 } });
      test('all guide pages fit and use the system theme and shared fonts', async ({ page }) => {
        await serveGuide(page);
        for (const entry of GUIDE_PAGES) {
          await page.goto(`https://guide.test/guide/${entry.slug}.html`);
          await page.evaluate(() => document.fonts.ready);
          await expect(page.locator('h1')).toBeVisible();
          expect(
            await page
              .locator('article img')
              .evaluateAll((images) =>
                images.every(
                  (image) =>
                    (image as HTMLImageElement).complete &&
                    (image as HTMLImageElement).naturalWidth > 0,
                ),
              ),
          ).toBe(true);
          await expect(
            page.locator('nav[aria-label="User guide"] a[aria-current="page"]'),
          ).toHaveAttribute('href', `${entry.slug}.html`);
          await expect(page.locator('body')).toHaveCSS(
            'background-color',
            colorScheme === 'dark' ? 'rgb(19, 18, 17)' : 'rgb(248, 247, 245)',
          );
          const layout = await page.evaluate(() => ({
            width: document.documentElement.scrollWidth,
            fonts: document.fonts.check('18px Figtree') && document.fonts.check('36px Fraunces'),
            boxes: [
              ...document.querySelectorAll('.site-header a, .guide-sidebar, .guide-content'),
            ].map((node) => {
              const box = node.getBoundingClientRect();
              return { left: box.left, right: box.right };
            }),
          }));
          expect(layout.width).toBeLessThanOrEqual(width);
          expect(layout.fonts).toBe(true);
          for (const box of layout.boxes) {
            expect(box.left).toBeGreaterThanOrEqual(0);
            expect(box.right).toBeLessThanOrEqual(width);
          }
        }
      });
    });
  }
}

test('table columns keep short words whole at desktop and mobile widths', async ({ page }) => {
  await serveGuide(page);
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('https://guide.test/guide/ftp.html');
    await page.evaluate(() => document.fonts.ready);
    for (const word of ['Mode', 'Passive', 'Active']) {
      const cell = page.locator('th, td').filter({ hasText: new RegExp(`^${word}$`) });
      const lines = await cell.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects().length;
      });
      expect(lines, `${word} at ${width}px`).toBe(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
});

test('mobile readers reach the introduction before expanding navigation', async ({ page }) => {
  await serveGuide(page);
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('https://guide.test/guide/getting-started.html');
    await page.evaluate(() => document.fonts.ready);
    const intro = page.locator('article > p').first();
    expect((await intro.boundingBox())!.y).toBeLessThan(400);
    await expect(page.locator('.guide-chapters')).not.toHaveAttribute('open');
    await expect(page.locator('.guide-toc')).not.toHaveAttribute('open');
    await page.getByText('Guide chapters', { exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('navigation', { name: 'User guide' })).toBeVisible();
    await page.getByRole('link', { name: 'Troubleshooting', exact: true }).first().click();
    await expect(page.locator('h1')).toHaveText('Troubleshooting');
  }
});

test('chapters can be opened without JavaScript and scrolled in a short desktop window', async ({
  browser,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 1280, height: 600 },
  });
  const page = await context.newPage();
  try {
    await serveGuide(page);
    await page.goto('https://guide.test/guide/sftp.html');
    await page.getByText('Guide chapters', { exact: true }).click();
    await page.evaluate(() => scrollTo(0, 1000));
    const sidebar = page.locator('.guide-sidebar');
    const box = (await sidebar.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(600);
    await sidebar.getByRole('link', { name: 'Troubleshooting', exact: true }).click();
    await expect(page).toHaveURL(/troubleshooting.html$/);
  } finally {
    await context.close();
  }
});

test('the shared header keeps its actions reachable on narrow screens', async ({ page }) => {
  await serveGuide(page);
  await page.goto('https://guide.test/guide/index.html');
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const header = page.locator('.site-header');
    await expect(header.getByRole('link', { name: 'Support FTPeach on Ko-fi' })).toBeVisible();
    await expect(header.getByRole('button', { name: 'Switch to light theme' })).toBeVisible();
    await expect(header.getByRole('link', { name: 'Download' })).toBeVisible();
    const boxes = await header.locator('.wrap > *').evaluateAll((elements) =>
      elements
        .map((element) => element.getBoundingClientRect())
        .filter((box) => box.width > 0)
        .map((box) => ({ left: box.left, right: box.right })),
    );
    for (let index = 0; index < boxes.length; index++) {
      expect(boxes[index]!.left).toBeGreaterThanOrEqual(index ? boxes[index - 1]!.right : 0);
      expect(boxes[index]!.right).toBeLessThanOrEqual(width);
    }
  }
});

test('screenshots enlarge without leaving the guide and restore reading position', async ({
  page,
}) => {
  await serveGuide(page);
  await page.goto('https://guide.test/guide/getting-started.html');
  const thumbnail = page.locator('article a:has(> img)').nth(1);
  const viewer = page.getByRole('dialog', { name: 'Enlarged screenshot' });
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await thumbnail.scrollIntoViewIfNeeded();
    await thumbnail.focus();
    const position = await page.evaluate(() => scrollY);
    const url = page.url();
    await page.keyboard.press('Enter');
    await expect(viewer).toBeVisible();
    await expect(viewer.locator('img')).toHaveAttribute('src', /images\/guide\/connection.png$/);
    await expect(viewer.getByRole('button', { name: 'Close screenshot' })).toBeFocused();
    const bounds = await viewer.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    if (width < 600) {
      const stage = viewer.locator('.guide-image-stage');
      expect(await stage.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
      await stage.evaluate((node) => {
        node.scrollLeft = 100;
      });
      expect(await stage.evaluate((node) => node.scrollLeft)).toBe(100);
    } else {
      expect(
        await viewer
          .locator('.guide-image-stage')
          .evaluate((node) => node.scrollHeight <= node.clientHeight),
      ).toBe(true);
      expect((await viewer.locator('img').boundingBox())!.width).toBeGreaterThan(
        (await thumbnail.locator('img').boundingBox())!.width,
      );
    }
    await page.keyboard.press('Escape');
    await expect(viewer).not.toBeVisible();
    await expect(thumbnail).toBeFocused();
    expect(page.url()).toBe(url);
    expect(await page.evaluate(() => scrollY)).toBe(position);
    await thumbnail.click();
    await viewer.getByRole('button', { name: 'Close screenshot' }).click();
    await expect(viewer).not.toBeVisible();
    await thumbnail.click();
    await page.mouse.click(2, 2);
    await expect(viewer).not.toBeVisible();
    expect(page.url()).toBe(url);
    expect(await page.evaluate(() => scrollY)).toBe(position);
  }
});

test('theme choice persists between guide pages and keyboard links reach sections', async ({
  page,
}) => {
  await serveGuide(page);
  await page.goto('https://guide.test/guide/index.html');
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page
    .getByRole('navigation', { name: 'User guide', exact: true })
    .getByRole('link', { name: 'Transfers and files' })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const link = page
    .getByRole('navigation', { name: 'On this page' })
    .getByRole('link', { name: 'Interrupted downloads' });
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#interrupted-downloads$/);
  expect(
    await page
      .locator('#interrupted-downloads')
      .evaluate((node) => node.getBoundingClientRect().top),
  ).toBeGreaterThanOrEqual(68);
});
