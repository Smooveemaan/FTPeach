import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fillRelease, type Release } from '../../../scripts/site/build.ts';

const html = await readFile(new URL('../../../site/index.html', import.meta.url), 'utf8');
const download = (name: string) => ({
  name,
  browser_download_url: `https://github.com/Smooveemaan/ftpeach/releases/download/v1.2.3/${name}`,
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
  const page = fillRelease(html, release);
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
  const page = fillRelease(html, release);
  assert.match(page, /Coming in the next release/);
  assert.doesNotMatch(page, /Download portable|portable\.zip"/);
});

test('a release without an installer stops the build', () => {
  assert.throws(() => fillRelease(html, { tag_name: 'v1.2.3', assets: [] }), /no installer/);
});
