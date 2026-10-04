import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
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
