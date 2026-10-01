// Runs after the release build, on the files about to be published. It keeps
// the updater signature, Authenticode and advisory exceptions apart, and it
// fails on the two things a release must never do: ship a broken or
// untimestamped Authenticode signature, or ship the updater private key.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  authenticodeVerdict,
  ignoredAdvisories,
  parseAdvisoryRegister,
  privateKeyHits,
  releaseMatrixLines,
  type AuthenticodeResult,
} from './release-trust.ts';

// A different release directory can be given for a local dry run.
const releaseDir = process.argv[2] ?? 'src-tauri/target/release';
const bundleDir = path.join(releaseDir, 'bundle');

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function authenticode(file: string): AuthenticodeResult {
  const script = [
    `$s = Get-AuthenticodeSignature -LiteralPath '${file.replaceAll("'", "''")}'`,
    '[pscustomobject]@{ status = $s.Status.ToString(); signer = $s.SignerCertificate.Subject; timestamped = $null -ne $s.TimeStamperCertificate } | ConvertTo-Json -Compress',
  ].join('; ');
  const output = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  const parsed = JSON.parse(output) as {
    status: string;
    signer: string | null;
    timestamped: boolean;
  };
  return {
    status: parsed.status,
    signer: parsed.signer ?? undefined,
    timestamped: parsed.timestamped,
  };
}

const bundleFiles = await filesUnder(bundleDir);
const installers = bundleFiles.filter((file) => file.endsWith('-setup.exe'));
if (installers.length === 0) throw new Error(`No NSIS installer under ${bundleDir}`);
// Cargo names the binary after the `app` package; the installer renames it.
const appExe = path.join(releaseDir, 'app.exe');
const executables = [...installers, appExe];

const problems: string[] = [];
const lines = ['## Release trust report', ''];

lines.push('### Artifacts', '', '| File | SHA-256 |', '| --- | --- |');
const portableZips = bundleFiles.filter((file) => file.endsWith('-portable.zip'));
for (const file of [...executables, ...portableZips]) {
  const digest = createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
  lines.push(`| ${path.basename(file)} | \`${digest}\` |`);
}

lines.push('', '### Updater signature (minisign)', '');
const signatures = bundleFiles.filter((file) => file.endsWith('.sig'));
for (const signature of signatures) {
  lines.push(
    `- ${path.basename(signature)}: verified against plugins.updater.pubkey by the previous step`,
  );
}
lines.push(
  '',
  'Only the in-app updater checks this signature. It says nothing to Windows about the first download.',
);

lines.push('', '### Windows Authenticode', '');
for (const file of executables) {
  const verdict = authenticodeVerdict(path.basename(file), authenticode(file));
  lines.push(`- ${verdict.ok ? '' : '**FAIL** '}${verdict.summary}`);
  if (!verdict.ok) problems.push(verdict.summary);
}

// The installer is compressed, so its own bytes cannot show what went into
// it. Scan the uncompressed inputs: the app executable and every bundle file.
lines.push('', '### Private signing key', '');
const secret = process.env.TAURI_SIGNING_PRIVATE_KEY;
const scanned = [appExe, ...bundleFiles];
for (const file of scanned) {
  for (const hit of privateKeyHits(await readFile(file), secret)) {
    problems.push(`${file} contains ${hit}`);
  }
}
const keyProblems = problems.filter((problem) => problem.includes(' contains '));
lines.push(
  keyProblems.length === 0
    ? `- Not found in ${scanned.length} file(s)${secret ? '' : ' (no secret given; header markers only)'}`
    : `- **FAIL** ${keyProblems.join('; ')}`,
);

lines.push('', '### RustSec exceptions carried by this build', '');
const register = parseAdvisoryRegister(await readFile('docs/rust-advisories.md', 'utf8'));
lines.push('| Advisory | Kind | Review by |', '| --- | --- | --- |');
for (const id of ignoredAdvisories(await readFile('deny.toml', 'utf8'))) {
  const row = register.get(id);
  lines.push(`| ${id} | ${row?.kind ?? 'unregistered'} | ${row?.reviewBy ?? '-'} |`);
}

lines.push(
  '',
  '### Verification matrix',
  '',
  'Record manual results in docs/native-validation.md before publishing the draft.',
  '',
  '| Cell | Result |',
  '| --- | --- |',
  ...releaseMatrixLines(await readFile('docs/verification-matrix.md', 'utf8')),
);

const report = `${lines.join('\n')}\n`;
console.log(report);
await mkdir('release', { recursive: true });
await writeFile('release/release-trust-report.md', report);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
if (problems.length > 0) {
  console.error(`Release trust report failed:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  process.exitCode = 1;
}
