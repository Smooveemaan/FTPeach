import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';

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
const ref = process.env.GITHUB_REF_NAME;
assert.ok(ref, 'GITHUB_REF_NAME must be set (this script runs as a GitHub Actions step)');
const supportBadgeUrl = `https://raw.githubusercontent.com/${repository}/${ref}/assets/images/support.png`;
const body = `${notes}\n\n---\n\nIf FTPeach is useful to you, you can also support its development:\n\n<a href="https://ko-fi.com/smooveemaan"><img src="${supportBadgeUrl}" alt="Support FTPeach on Ko-fi" width="160"></a>`;

const githubOutputPath = process.env.GITHUB_OUTPUT;
assert.ok(
  githubOutputPath,
  'GITHUB_OUTPUT must be set (this script runs as a GitHub Actions step)',
);

const delimiter = `FTPEACH_RELEASE_NOTES_${Math.random().toString(36).slice(2)}`;
assert.ok(!body.includes(delimiter), 'Generated delimiter collided with release notes content');
await appendFile(githubOutputPath, `body<<${delimiter}\n${body}\n${delimiter}\n`);

console.log(`Extracted release notes for v${version} from CHANGELOG.md (${notes.length} chars).`);
