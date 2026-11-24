// Runs after the release build, on the files about to be published. It keeps
// the updater signature, Authenticode and advisory exceptions apart, and it
// fails on the two things a release must never do: ship a broken or
// untimestamped Authenticode signature, or ship the updater private key.
import assert from 'node:assert/strict';
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
  type Verdict,
} from './release-trust.ts';

interface TrustFragment {
  extraDigests?: { file: string; sha256: string }[];
  authenticode?: Verdict[];
  scannedCount: number;
  secretProvided: boolean;
  problems: string[];
}

async function filesUnder(directory: string, excludeMeta = false): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => {
      if (!entry.isFile()) return false;
      if (!excludeMeta) return true;
      const relative = path.relative(directory, path.join(entry.parentPath, entry.name));
      return relative.split(path.sep)[0] !== 'meta';
    })
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

function authenticode(file: string): AuthenticodeResult {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$s = Get-AuthenticodeSignature -LiteralPath '${file.replaceAll("'", "''")}'`,
    '[pscustomobject]@{ status = $s.Status.ToString(); signer = $s.SignerCertificate.Subject; timestamped = $null -ne $s.TimeStamperCertificate } | ConvertTo-Json -Compress',
  ].join('; ');
  const output = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
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

async function digestFile(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

async function scanPrivateKey(files: string[], secret: string | undefined): Promise<string[]> {
  const problems: string[] = [];
  for (const file of files) {
    for (const hit of privateKeyHits(await readFile(file), secret)) {
      problems.push(`${file} contains ${hit}`);
    }
  }
  return problems;
}

async function writeFragment(outPath: string, fragment: TrustFragment) {
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(fragment, null, 2)}\n`);
  if (fragment.problems.length > 0) {
    console.error(
      `Release trust check failed:\n${fragment.problems.map((p) => `- ${p}`).join('\n')}`,
    );
    process.exitCode = 1;
  }
}

async function renderReport(options: {
  artifacts: { file: string; sha256: string }[];
  signatures: string[];
  authenticodeVerdicts: Verdict[];
  scannedCount: number;
  secretProvided: boolean;
  problems: string[];
}) {
  const lines = ['## Release trust report', ''];

  lines.push('### Artifacts', '', '| File | SHA-256 |', '| --- | --- |');
  for (const artifact of options.artifacts) {
    lines.push(`| ${artifact.file} | \`${artifact.sha256}\` |`);
  }

  lines.push('', '### Updater signature (minisign)', '');
  for (const signature of options.signatures) {
    lines.push(`- ${signature}: verified against plugins.updater.pubkey by the previous step`);
  }
  lines.push(
    '',
    'Only the in-app updater checks this signature. It says nothing to Windows about the first download.',
  );

  lines.push('', '### Windows Authenticode', '');
  for (const verdict of options.authenticodeVerdicts) {
    lines.push(`- ${verdict.ok ? '' : '**FAIL** '}${verdict.summary}`);
  }

  lines.push('', '### Private signing key', '');
  const keyProblems = options.problems.filter((problem) => problem.includes(' contains '));
  lines.push(
    keyProblems.length === 0
      ? `- Not found in ${options.scannedCount} file(s)${options.secretProvided ? '' : ' (no secret given; header markers only)'}`
      : `- **FAIL** ${keyProblems.join('; ')}`,
  );

  lines.push('', '### RustSec exceptions carried by this build', '');
  const register = parseAdvisoryRegister(await readFile('docs/rust-advisories.md', 'utf8'));
  lines.push('| Advisory | Kind | Review by |', '| --- | --- | --- |');
  for (const id of ignoredAdvisories(await readFile('src-tauri/deny.toml', 'utf8'))) {
    const row = register.get(id);
    lines.push(`| ${id} | ${row?.kind ?? 'unregistered'} | ${row?.reviewBy ?? '-'} |`);
  }

  lines.push(
    '',
    '### Release matrix',
    '',
    "Record the local and manual results in the draft release's notes before publishing the draft.",
    '',
    '| Cell | Result |',
    '| --- | --- |',
    ...releaseMatrixLines(await readFile('docs/release-trust.md', 'utf8')),
  );

  const report = `${lines.join('\n')}\n`;
  console.log(report);
  await mkdir('release', { recursive: true });
  await writeFile('release/release-trust-report.md', report);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
  if (options.problems.length > 0) {
    console.error(
      `Release trust report failed:\n${options.problems.map((p) => `- ${p}`).join('\n')}`,
    );
    process.exitCode = 1;
  }
}

const mode = process.argv[2];

if (mode === '--scan') {
  const [, , , directory, outPath] = process.argv;
  assert.ok(directory && outPath, 'Usage: --scan <dir> <outJson>');
  const files = await filesUnder(directory, true);
  assert.ok(files.length > 0, `No files to scan under ${directory}`);
  const secret = process.env.TAURI_SIGNING_PRIVATE_KEY;
  const problems = await scanPrivateKey(files, secret);
  await writeFragment(outPath, {
    scannedCount: files.length,
    secretProvided: Boolean(secret),
    problems,
  });
} else if (mode === '--windows') {
  const [, , , releaseDir, outPath] = process.argv;
  assert.ok(releaseDir && outPath, 'Usage: --windows <releaseDir> <outJson>');
  const bundleDir = path.join(releaseDir, 'bundle');
  const bundleFiles = await filesUnder(bundleDir);
  const installers = bundleFiles.filter((file) => file.endsWith('-setup.exe'));
  if (installers.length === 0) throw new Error(`No NSIS installer under ${bundleDir}`);
  // Cargo names the binary after the `FTPeach` package.
  const appExe = path.join(releaseDir, 'FTPeach.exe');
  const executables = [...installers, appExe];
  const problems: string[] = [];
  const verdicts: Verdict[] = [];
  for (const file of executables) {
    const verdict = authenticodeVerdict(path.basename(file), authenticode(file));
    verdicts.push(verdict);
    if (!verdict.ok) problems.push(verdict.summary);
  }
  const secret = process.env.TAURI_SIGNING_PRIVATE_KEY;
  const scanned = [appExe, ...bundleFiles];
  problems.push(...(await scanPrivateKey(scanned, secret)));
  await writeFragment(outPath, {
    extraDigests: [{ file: path.basename(appExe), sha256: await digestFile(appExe) }],
    authenticode: verdicts,
    scannedCount: scanned.length,
    secretProvided: Boolean(secret),
    problems,
  });
} else if (mode === '--aggregate') {
  const [, , , candidateDir, ...fragmentPaths] = process.argv;
  assert.ok(
    candidateDir && fragmentPaths.length > 0,
    'Usage: --aggregate <candidateDir> <fragment.json...>',
  );
  const fragments = await Promise.all(
    fragmentPaths.map(async (file) => JSON.parse(await readFile(file, 'utf8')) as TrustFragment),
  );
  const candidateFiles = await filesUnder(candidateDir, true);
  const installers = candidateFiles.filter((file) => file.endsWith('-setup.exe'));
  if (installers.length === 0) throw new Error(`No NSIS installer under ${candidateDir}`);
  const extraArtifacts = candidateFiles.filter((file) =>
    /(-portable\.zip|\.msix|\.dmg|\.app\.tar\.gz|\.AppImage|\.deb)$/.test(file),
  );
  const artifacts: { file: string; sha256: string }[] = [];
  for (const file of installers) {
    artifacts.push({ file: path.basename(file), sha256: await digestFile(file) });
  }
  for (const fragment of fragments) {
    for (const digest of fragment.extraDigests ?? []) artifacts.push(digest);
  }
  for (const file of extraArtifacts) {
    artifacts.push({ file: path.basename(file), sha256: await digestFile(file) });
  }
  const signatures = candidateFiles
    .filter((file) => file.endsWith('.sig'))
    .map((file) => path.basename(file));
  const authenticodeVerdicts = fragments.flatMap((fragment) => fragment.authenticode ?? []);
  assert.ok(
    authenticodeVerdicts.length > 0,
    'Aggregated trust report requires Windows Authenticode verdicts',
  );
  const scannedCount = fragments.reduce((sum, fragment) => sum + fragment.scannedCount, 0);
  const secretProvided = fragments.every((fragment) => fragment.secretProvided);
  const problems = fragments.flatMap((fragment) => fragment.problems);
  await renderReport({
    artifacts,
    signatures,
    authenticodeVerdicts,
    scannedCount,
    secretProvided,
    problems,
  });
} else {
  // A different release directory can be given for a local dry run.
  const releaseDir = process.argv[2] ?? 'src-tauri/target/release';
  const bundleDir = path.join(releaseDir, 'bundle');
  const bundleFiles = await filesUnder(bundleDir);
  const installers = bundleFiles.filter((file) => file.endsWith('-setup.exe'));
  if (installers.length === 0) throw new Error(`No NSIS installer under ${bundleDir}`);
  // Cargo names the binary after the `FTPeach` package.
  const appExe = path.join(releaseDir, 'FTPeach.exe');
  const executables = [...installers, appExe];
  const extraArtifacts = bundleFiles.filter((file) =>
    /(-portable\.zip|\.msix|\.dmg|\.app\.tar\.gz|\.AppImage|\.deb)$/.test(file),
  );
  const artifacts: { file: string; sha256: string }[] = [];
  for (const file of [...executables, ...extraArtifacts]) {
    artifacts.push({ file: path.basename(file), sha256: await digestFile(file) });
  }
  const signatures = bundleFiles
    .filter((file) => file.endsWith('.sig'))
    .map((file) => path.basename(file));
  const problems: string[] = [];
  const authenticodeVerdicts: Verdict[] = [];
  for (const file of executables) {
    const verdict = authenticodeVerdict(path.basename(file), authenticode(file));
    authenticodeVerdicts.push(verdict);
    if (!verdict.ok) problems.push(verdict.summary);
  }
  // The installer is compressed, so its own bytes cannot show what went into
  // it. Scan the uncompressed inputs: the app executable and every bundle file.
  const secret = process.env.TAURI_SIGNING_PRIVATE_KEY;
  const scanned = [appExe, ...bundleFiles];
  problems.push(...(await scanPrivateKey(scanned, secret)));
  await renderReport({
    artifacts,
    signatures,
    authenticodeVerdicts,
    scannedCount: scanned.length,
    secretProvided: Boolean(secret),
    problems,
  });
}
