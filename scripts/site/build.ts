// Builds the GitHub Pages site into dist-site/: site/index.html with the
// latest release's version and download links and the repository's star and
// download counts filled in, next to the images it shows. The counts are
// fetched here, not by the page, so visitors' browsers never call GitHub's API.
// The Pages workflow runs it on a push, when a release is published and once a
// day; `npm run site:build` runs it locally.
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface Release {
  tag_name: string;
  assets: { name: string; browser_download_url: string; download_count?: number }[];
}

export interface Stats {
  stars: number;
  downloads: number;
}

/** A download count says something good about the app only from here on. */
export const DOWNLOADS_SHOWN_FROM = 1000;

const SETUP = '_x64-setup.exe';
const PORTABLE = '_x64-portable.zip';
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/**
 * Fills the release and count placeholders. The portable copy is offered only
 * when the release has one; otherwise the page keeps its "coming" note. The
 * download count is left out until it reaches DOWNLOADS_SHOWN_FROM.
 */
export function fillPage(html: string, release: Release, stats: Stats): string {
  const asset = (suffix: string) => release.assets.find((a) => a.name.endsWith(suffix));
  const setup = asset(SETUP);
  if (!setup) throw new Error(`${release.tag_name} has no installer`);
  const portable = asset(PORTABLE);
  const [keep, drop] = portable ? ['available', 'missing'] : ['missing', 'available'];
  const filled = html
    .replace(
      new RegExp(`[ \\t]*<!-- portable:${drop} -->[\\s\\S]*?<!-- /portable:${drop} -->\\n`),
      '',
    )
    .replace(new RegExp(`[ \\t]*<!-- /?portable:${keep} -->\\n`, 'g'), '')
    .replace(/<!-- downloads -->([\s\S]*?)<!-- \/downloads -->/, (_, shown: string) =>
      stats.downloads >= DOWNLOADS_SHOWN_FROM ? shown : '',
    )
    .replaceAll('{{VERSION}}', release.tag_name)
    .replaceAll('{{SETUP_URL}}', setup.browser_download_url)
    .replaceAll('{{SETUP_NAME}}', setup.name)
    .replaceAll('{{PORTABLE_URL}}', portable?.browser_download_url ?? '')
    .replaceAll('{{PORTABLE_NAME}}', portable?.name ?? '')
    .replaceAll('{{STARS}}', compact.format(stats.stars))
    .replaceAll('{{STARS_LABEL}}', `${stats.stars.toLocaleString('en')} stars on GitHub`)
    .replaceAll('{{DOWNLOADS}}', compact.format(stats.downloads));
  const left = /\{\{\w+\}\}|<!-- \/?(?:portable|downloads)/.exec(filled);
  if (left) throw new Error(`site/index.html still has ${left[0]}`);
  return filled;
}

/** People's downloads of the app: installers and portable copies, not updater checks. */
export function countDownloads(releases: Release[]): number {
  return releases
    .flatMap((r) => r.assets)
    .filter((a) => a.name.endsWith(SETUP) || a.name.endsWith(PORTABLE))
    .reduce((sum, a) => sum + (a.download_count ?? 0), 0);
}

async function github<T>(endpoint: string): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const url = `https://api.github.com/repos/Smooveemaan/ftpeach${endpoint}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function main() {
  const root = path.resolve(import.meta.dirname, '../..');
  const out = path.join(root, 'dist-site');
  const html = await readFile(path.join(root, 'site/index.html'), 'utf8');
  const [release, releases, repo] = await Promise.all([
    github<Release>('/releases/latest'),
    // ponytail: newest 100 releases only; page through them if there are ever more
    github<Release[]>('/releases?per_page=100'),
    github<{ stargazers_count: number }>(''),
  ]);
  const stats = { stars: repo.stargazers_count, downloads: countDownloads(releases) };
  await rm(out, { recursive: true, force: true });
  await mkdir(out);
  await writeFile(path.join(out, 'index.html'), fillPage(html, release, stats));
  for (const image of [
    'ftpeach.png',
    'ftpeach-light.png',
    'ftpeach.mp4',
    'ftpeach-poster.webp',
    'ftpeach-light.mp4',
    'ftpeach-light-poster.webp',
    'icon.png',
    'og.jpg',
  ]) {
    await copyFile(path.join(root, 'assets/images', image), path.join(out, image));
  }
  await copyFile(path.join(root, 'public/favicon.ico'), path.join(out, 'favicon.ico'));
  console.log(
    `Built dist-site for ${release.tag_name}: ${stats.stars} stars, ${stats.downloads} downloads`,
  );
}

if (import.meta.filename === process.argv[1]) await main();
