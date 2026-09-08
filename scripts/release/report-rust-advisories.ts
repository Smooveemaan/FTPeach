// Weekly evidence supplements cargo-deny's ignore list. A new upstream version
// is a review signal, never proof that RSA signing is constant-time.
import { appendFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const policy = await readFile('deny.toml', 'utf8');
const ids = [...policy.matchAll(/id\s*=\s*"(RUSTSEC-\d{4}-\d{4})"/g)].map((m) => m[1]!);
const lines = ['## Rust advisory review evidence', '', `Checked: ${new Date().toISOString()}`, ''];
const tree = execFileSync(
  'cargo',
  [
    'tree',
    '--locked',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--target',
    'x86_64-pc-windows-msvc',
    '-i',
    'rsa',
  ],
  { encoding: 'utf8', timeout: 120_000 },
);
lines.push('### Locked RSA dependency chain', '', '```text', tree.trim(), '```', '');

async function get(url: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'FTPeach-security-audit (github.com/Smooveemaan/ftpeach)' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

const releases = (await (await get('https://crates.io/api/v1/crates/russh')).json()) as {
  crate: { max_version: string; max_stable_version: string | null };
};
lines.push(
  `Latest russh: ${releases.crate.max_version}; stable: ${releases.crate.max_stable_version ?? 'none'}.`,
  'Compare with the locked chain above. A version change requires a signing-path review; it does not establish a fix.',
  '',
  '### Current RustSec patch availability',
  '',
);
for (const id of ids) {
  const year = id.split('-')[1];
  const url = `https://raw.githubusercontent.com/RustSec/advisory-db/main/crates`;
  // The advisory database API maps IDs to crate names via the public OSV record.
  const osv = (await (await get(`https://api.osv.dev/v1/vulns/${id}`)).json()) as {
    affected?: { package: { name: string } }[];
  };
  const name = osv.affected?.[0]?.package.name;
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`${id}: missing crate name`);
  const advisory = await (await get(`${url}/${name}/${id}.md`)).text();
  const versions = advisory.match(/\[versions\]([\s\S]*?)(?:\n\[|\n```)/)?.[1]?.trim();
  if (!versions) throw new Error(`${id}: missing RustSec version metadata (${year})`);
  lines.push(`**${id} (${name})**`, '', '```toml', versions, '```', '');
}
const report = `${lines.join('\n')}\n`;
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
