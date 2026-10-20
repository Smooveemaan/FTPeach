import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { renderGuide } from '../../../scripts/site/guide.ts';
import {
  countDownloads,
  DOWNLOADS_SHOWN_FROM,
  fillPage,
  type Release,
} from '../../../scripts/site/build.ts';

const html = await readFile(new URL('../../../site/index.html', import.meta.url), 'utf8');
const download = (name: string) => ({
  name,
  browser_download_url: `https://github.com/Smooveemaan/ftpeach/releases/download/v1.2.3/${name}`,
});
const stats = { stars: 10, downloads: 60 };

test('Compare is a separate article reachable from both navigation areas with valid local links', async () => {
  const article = new JSDOM(
    await readFile(new URL('../../../site/compare.html', import.meta.url), 'utf8'),
  ).window.document;
  assert.equal(article.querySelectorAll('h1').length, 1);
  assert.equal(
    article.querySelector('link[rel="canonical"]')?.getAttribute('href'),
    'https://ftpeach.com/compare.html',
  );
  assert.ok(article.querySelector('meta[name="description"]')?.getAttribute('content'));
  assert.equal(article.querySelector('.guide-sidebar'), null);
  assert.ok(article.querySelector('time[datetime]'));
  assert.equal(article.querySelectorAll('thead th[scope="col"]').length, 4);
  for (const source of [html, article.documentElement.outerHTML]) {
    const doc = new JSDOM(source).window.document;
    for (const area of ['.site-header', '.site-footer'])
      assert.equal(doc.querySelector(`${area} a[href="compare.html"]`)?.textContent, 'Compare');
  }
  for (const link of article.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href')!;
    if (href.startsWith('https://')) continue;
    const [file, fragment] = href.split('#');
    let target = article;
    if (file?.startsWith('guide/')) {
      const slug = file.slice(6, -5);
      target = new JSDOM(
        renderGuide(
          await readFile(new URL(`../../../docs/guide/${slug}.md`, import.meta.url), 'utf8'),
          slug,
        ).content,
      ).window.document;
    } else if (file && file !== 'compare.html') {
      target = new JSDOM(await readFile(new URL(`../../../site/${file}`, import.meta.url), 'utf8'))
        .window.document;
    }
    if (fragment) assert.ok(target.getElementById(fragment), href);
  }
});

test('a release with a portable copy offers both downloads', () => {
  const release: Release = {
    tag_name: 'v1.2.3',
    assets: [
      download('latest.json'),
      download('FTPeach_1.2.3_x64-setup.exe'),
      download('FTPeach_1.2.3_x64-portable.zip'),
    ],
  };
  const page = fillPage(html, release, stats);
  assert.match(page, /href="[^"]+\/FTPeach_1\.2\.3_x64-setup\.exe"/);
  assert.match(page, /href="[^"]+\/FTPeach_1\.2\.3_x64-portable\.zip"/);
  assert.match(page, /v1\.2\.3(?:<\/span>)? · Windows/);
  assert.doesNotMatch(page, /Coming in the next release/);
  assert.match(page, /"downloadUrl": "[^"]+\/FTPeach_1\.2\.3_x64-setup\.exe"/);
});

test('a release without a portable copy says it is coming', () => {
  const release: Release = {
    tag_name: 'v1.2.3',
    assets: [download('FTPeach_1.2.3_x64-setup.exe')],
  };
  const page = fillPage(html, release, stats);
  assert.match(page, /Coming in the next release/);
  assert.doesNotMatch(page, /Download portable|portable\.zip"/);
});

test('search metadata describes the released app and the FTPeach project', () => {
  for (const tag of ['v1.2.3', '1.2.3']) {
    const page = fillPage(
      html,
      { tag_name: tag, assets: [download('FTPeach_1.2.3_x64-setup.exe')] },
      stats,
    );
    const script = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(page);
    assert.ok(script?.[1]);
    const data = JSON.parse(script[1]) as Record<string, unknown>[];
    const app = data.find((entry) => entry['@type'] === 'SoftwareApplication');
    assert.ok(app);
    assert.equal(app.softwareVersion, '1.2.3');
    assert.equal(app.screenshot, 'https://ftpeach.com/ftpeach-dark.png');
    assert.equal(app.image, 'https://ftpeach.com/icon.png');
    const project = data.find((entry) => entry['@type'] === 'Organization');
    assert.ok(project);
    assert.equal(project.name, 'FTPeach');
    assert.equal(project.url, 'https://ftpeach.com/');
    assert.equal(project.logo, 'https://ftpeach.com/icon.png');
  }
});

test('a release without an installer stops the build', () => {
  assert.throws(() => fillPage(html, { tag_name: 'v1.2.3', assets: [] }, stats), /no installer/);
});

test('the star count is filled in, shortened once it is large', () => {
  const release: Release = {
    tag_name: 'v1.2.3',
    assets: [download('FTPeach_1.2.3_x64-setup.exe')],
  };
  const page = fillPage(html, release, { stars: 1234, downloads: 0 });
  assert.match(page, /aria-label="1,234 stars on GitHub"/);
  assert.match(page, /<\/svg>1\.2K<\/span>/);
});

test('the download count appears only once it is large enough', () => {
  const release: Release = {
    tag_name: 'v1.2.3',
    assets: [download('FTPeach_1.2.3_x64-setup.exe')],
  };
  const few = fillPage(html, release, { stars: 10, downloads: DOWNLOADS_SHOWN_FROM - 1 });
  assert.doesNotMatch(few, /downloads ·/);
  assert.match(few, /64-bit ·\n/);
  const many = fillPage(html, release, { stars: 10, downloads: 12_345 });
  assert.match(many, /64-bit · 12\.3K downloads ·\n/);
});

test('downloads count installers and portable copies, not updater checks', () => {
  const asset = (name: string, download_count: number) => ({ ...download(name), download_count });
  const releases: Release[] = [
    {
      tag_name: 'v1.2.3',
      assets: [
        asset('FTPeach_1.2.3_x64-setup.exe', 20),
        asset('FTPeach_1.2.3_x64-portable.zip', 5),
        asset('latest.json', 900),
      ],
    },
    { tag_name: 'v1.2.2', assets: [asset('FTPeach_1.2.2_x64-setup.exe', 10)] },
  ];
  assert.equal(countDownloads(releases), 35);
});
