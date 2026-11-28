import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isMultiPlatformVersion } from './candidate.ts';

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const version = packageJson.version;
assert.equal(typeof version, 'string', 'package.json must declare a version');

const changelog = await readFile('CHANGELOG.md', 'utf8');
const headingPattern = new RegExp(
  `^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\].*$`,
  'm',
);
const headingMatch = changelog.match(headingPattern);
assert.ok(headingMatch, `CHANGELOG.md has no "## [${version}]" section to use as release notes`);
assert.ok(typeof headingMatch.index === 'number', 'Matched heading is missing its string index');

const sectionStart = headingMatch.index + headingMatch[0].length;
const nextHeadingIndex = changelog.indexOf('\n## [', sectionStart);
const sectionEnd = nextHeadingIndex === -1 ? changelog.length : nextHeadingIndex;
const notes = changelog.slice(sectionStart, sectionEnd).trim();
assert.ok(notes.length > 0, `CHANGELOG.md's "## [${version}]" section is empty`);

const repository = process.env.GITHUB_REPOSITORY;
assert.ok(repository, 'GITHUB_REPOSITORY must be set (this script runs as a GitHub Actions step)');
const images = `https://raw.githubusercontent.com/${repository}/master/assets/images`;
const download = (file: string) =>
  `https://github.com/${repository}/releases/download/v${version}/${file}`;
// A logo for each theme: GitHub picks the one that matches the reader's.
const logo = (href: string, name: string, alt: string, height: number) =>
  `<a href="${href}"><picture><source media="(prefers-color-scheme: dark)" srcset="${images}/${name}-dark.png"><img src="${images}/${name}-light.png" alt="${alt}" height="${height}" align="absmiddle"></picture></a>`;
const platformIcon = (name: string, alt: string) =>
  `<picture><source media="(prefers-color-scheme: dark)" srcset="${images}/platforms/${name}-dark.png"><img src="${images}/platforms/${name}-light.png" alt="${alt}" height="18" align="absmiddle"></picture>`;

const downloadRows = [
  `| ${platformIcon('windows', 'Windows')}&nbsp;&nbsp;**Windows** (64-bit) | [Installer (\`.exe\`)](${download(`FTPeach_${version}_x64-setup.exe`)})<br>[Portable (\`.zip\`)](${download(`FTPeach_${version}_x64-portable.zip`)}) | Standard installer.<br>Portable runs from a folder without installation. |`,
  ...(isMultiPlatformVersion(version)
    ? [
        `| ${platformIcon('macos', 'macOS')}&nbsp;&nbsp;**macOS** (Apple Silicon & Intel) | [Disk Image (\`.dmg\`)](${download(`FTPeach_${version}_universal.dmg`)}) | Universal build, signed & notarized. |`,
        `| ${platformIcon('linux', 'Linux')}&nbsp;&nbsp;**Linux** (x86_64) | [Debian / Ubuntu (\`.deb\`)](${download(`FTPeach_${version}_amd64.deb`)})<br>[AppImage (\`.AppImage\`)](${download(`FTPeach_${version}_amd64.AppImage`)}) | \`.deb\` for Debian and Ubuntu.<br>\`.AppImage\` for Fedora and other distros (requires FUSE). |`,
      ]
    : []),
];
const downloads = [
  '### Downloads',
  '',
  '| Platform | Download | Notes |',
  '| --- | --- | --- |',
  ...downloadRows,
].join('\n');

const support = [
  '### Support',
  '',
  'FTPeach is free to use with no paid version.',
  'If it saves you time, a donation helps keep it going.',
  '',
  `${logo('https://ko-fi.com/smooveemaan', 'kofi', 'Support FTPeach on Ko-fi', 20)}&emsp;${logo('https://www.patreon.com/Smooveemaan', 'patreon', 'Support FTPeach on Patreon', 18)}`,
].join('\n');

const body = `${notes}\n\n${downloads}\n\n${support}`;

const githubOutputPath = process.env.GITHUB_OUTPUT;
assert.ok(
  githubOutputPath,
  'GITHUB_OUTPUT must be set (this script runs as a GitHub Actions step)',
);
await mkdir('release', { recursive: true });
await writeFile('release/release-notes.md', `${body}\n`);

const delimiter = `FTPEACH_RELEASE_NOTES_${Math.random().toString(36).slice(2)}`;
assert.ok(!body.includes(delimiter), 'Generated delimiter collided with release notes content');
await appendFile(githubOutputPath, `body<<${delimiter}\n${body}\n${delimiter}\n`);

console.log(`Extracted release notes for v${version} from CHANGELOG.md (${notes.length} chars).`);
