// Weekly evidence supplements cargo-deny's ignore list by fetching live RustSec
// version metadata and verifying that docs/rust-advisories.md matches RustSec's
// current advisory classification.
import { appendFile, readFile } from 'node:fs/promises';
import { ignoredAdvisories, parseAdvisoryRegister, rustsecKind } from './release-trust.ts';

const policy = await readFile('src-tauri/deny.toml', 'utf8');
const ids = ignoredAdvisories(policy);
const register = parseAdvisoryRegister(await readFile('docs/rust-advisories.md', 'utf8'));
const lines = [
  '## Rust advisory review evidence',
  '',
  `Checked: ${new Date().toISOString()}`,
  '',
  '### Current RustSec patch availability',
  '',
];

async function get(url: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'FTPeach-security-audit (github.com/Smooveemaan/ftpeach)' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

if (ids.length === 0) {
  lines.push(
    'No RustSec advisory exceptions are currently configured in `src-tauri/deny.toml`.',
    '',
  );
}

for (const id of ids) {
  const year = id.split('-')[1];
  const url = 'https://raw.githubusercontent.com/RustSec/advisory-db/main/crates';
  // The advisory database API maps IDs to crate names via the public OSV record.
  const osv = (await (await get(`https://api.osv.dev/v1/vulns/${id}`)).json()) as {
    affected?: { package: { name: string } }[];
  };
  const name = osv.affected?.[0]?.package.name;
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`${id}: missing crate name`);
  const advisory = await (await get(`${url}/${name}/${id}.md`)).text();
  const versions = advisory.match(/\[versions\]([\s\S]*?)(?:\n\[|\n```)/)?.[1]?.trim();
  if (!versions) throw new Error(`${id}: missing RustSec version metadata (${year})`);
  // The register's class decides how the exception is argued, so it has to
  // agree with RustSec's, including when RustSec reclassifies an advisory.
  const kind = rustsecKind(advisory);
  const declared = register.get(id)?.kind;
  if (kind !== declared) {
    throw new Error(
      `${id}: register says ${declared ?? 'nothing'}, RustSec says ${kind ?? 'unknown'}`,
    );
  }
  lines.push(`**${id} (${name}, ${kind})**`, '', '```toml', versions, '```', '');
}
const report = `${lines.join('\n')}\n`;
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
