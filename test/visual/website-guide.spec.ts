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
    const file = name.startsWith('guide/')
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
