// Builds the GitHub Pages site into dist-site/: site/index.html with the
// latest release's version and download links filled in, next to the images
// it shows. The Pages workflow runs it on a push and when a release is
// published; `npm run site:build` runs it locally.
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface Release {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
}

/**
 * Fills the release placeholders. The portable copy is offered only when the
 * release has one; otherwise the page keeps its "coming" note.
 */
export function fillRelease(html: string, release: Release): string {
  const asset = (suffix: string) => release.assets.find((a) => a.name.endsWith(suffix));
  const setup = asset('_x64-setup.exe');
  if (!setup) throw new Error(`${release.tag_name} has no installer`);
  const portable = asset('_x64-portable.zip');
  const [keep, drop] = portable ? ['available', 'missing'] : ['missing', 'available'];
  const filled = html
    .replace(
      new RegExp(`[ \\t]*<!-- portable:${drop} -->[\\s\\S]*?<!-- /portable:${drop} -->\\n`),
      '',
    )
    .replace(new RegExp(`[ \\t]*<!-- /?portable:${keep} -->\\n`, 'g'), '')
    .replaceAll('{{VERSION}}', release.tag_name)
    .replaceAll('{{SETUP_URL}}', setup.browser_download_url)
    .replaceAll('{{SETUP_NAME}}', setup.name)
    .replaceAll('{{PORTABLE_URL}}', portable?.browser_download_url ?? '')
    .replaceAll('{{PORTABLE_NAME}}', portable?.name ?? '');
  const left = /\{\{\w+\}\}|<!-- \/?portable:/.exec(filled);
  if (left) throw new Error(`site/index.html still has ${left[0]}`);
  return filled;
}

async function latestRelease(): Promise<Release> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch('https://api.github.com/repos/Smooveemaan/ftpeach/releases/latest', {
    headers,
  });
  if (!response.ok) throw new Error(`latest release: HTTP ${response.status}`);
  return (await response.json()) as Release;
}

async function main() {
  const root = path.resolve(import.meta.dirname, '../..');
  const out = path.join(root, 'dist-site');
  const html = await readFile(path.join(root, 'site/index.html'), 'utf8');
  const release = await latestRelease();
  await rm(out, { recursive: true, force: true });
  await mkdir(out);
  await writeFile(path.join(out, 'index.html'), fillRelease(html, release));
  for (const image of [
    'ftpeach.png',
    'ftpeach-light.png',
    'ftpeach.mp4',
    'ftpeach-poster.webp',
    'icon.png',
  ]) {
    await copyFile(path.join(root, 'assets/images', image), path.join(out, image));
  }
  await copyFile(path.join(root, 'public/favicon.ico'), path.join(out, 'favicon.ico'));
  console.log(`Built dist-site for ${release.tag_name}`);
}

if (import.meta.filename === process.argv[1]) await main();
