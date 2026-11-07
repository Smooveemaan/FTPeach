import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  assetNeedsUpload,
  createVersionTag,
  MANUAL_CHECKS,
  tagMessage,
  validateManualAcceptance,
  validateTag,
  verifyAttestations,
  type ManualAcceptance,
} from '../../../scripts/release/finalize.ts';
import type { Candidate } from '../../../scripts/release/candidate.ts';

const sha = 'a'.repeat(40);
const hash = 'b'.repeat(64);
const candidate = {
  readiness: { version: '0.6.1', sha, repository: 'owner/app' },
  build: { runId: '123', attempt: '1', workflowSha: 'c'.repeat(40) },
} as Candidate;
const manual: ManualAcceptance = {
  sha,
  candidateHash: hash,
  tester: 'owner',
  checkedAt: '2026-01-01T12:00:00Z',
  results: Object.fromEntries(
    MANUAL_CHECKS.map((name) => [
      name,
      { result: 'passed', evidence: 'Recorded test on a clean machine' },
    ]),
  ),
};

test('deploy transport creates exactly one annotated candidate tag and cannot replace it', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'release-tag-'));
  const checkout = path.join(directory, 'checkout');
  const remote = path.join(directory, 'remote.git');
  try {
    execFileSync('git', ['init', checkout], { stdio: 'pipe' });
    execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'Candidate',
      ],
      { cwd: checkout, stdio: 'pipe' },
    );
    const source = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: checkout,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['push', remote, 'HEAD:refs/heads/master'], {
      cwd: checkout,
      stdio: 'pipe',
    });
    const accepted = {
      ...candidate,
      readiness: { ...candidate.readiness, sha: source },
    } as Candidate;
    let pushes = 0;
    const run = ((command: string, args: string[], options: object) => {
      args = [...args];
      if (args[0] === 'fetch') {
        assert.equal(args[3], 'https://github.com/owner/app.git');
        args[3] = pathToFileURL(checkout).href;
      }
      if (args[0] === 'push') {
        assert.deepEqual(args, [
          'push',
          '--no-follow-tags',
          'git@github.com:owner/app.git',
          'refs/tags/v0.6.1:refs/tags/v0.6.1',
        ]);
        args[2] = remote;
        pushes++;
      }
      return execFileSync(command, args, { ...options, cwd: checkout });
    }) as typeof execFileSync;
    createVersionTag(accepted, hash, run);
    const git = (args: string[]) =>
      execFileSync('git', ['--git-dir', remote, ...args], { encoding: 'utf8' }).trim();
    assert.equal(git(['cat-file', '-t', 'v0.6.1']), 'tag');
    assert.equal(git(['rev-parse', 'v0.6.1^{}']), source);
    assert.ok(git(['cat-file', '-p', 'v0.6.1']).endsWith(tagMessage('0.6.1', hash).trim()));
    assert.equal(git(['for-each-ref', '--format=%(refname)', 'refs/tags']), 'refs/tags/v0.6.1');
    assert.throws(() => createVersionTag(accepted, hash, run));
    assert.equal(pushes, 1);
    execFileSync('git', ['tag', '--delete', 'v0.6.1'], { cwd: checkout, stdio: 'pipe' });
    assert.throws(() => createVersionTag(accepted, 'c'.repeat(64), run));
    assert.equal(pushes, 2);
    assert.ok(git(['cat-file', '-p', 'v0.6.1']).endsWith(tagMessage('0.6.1', hash).trim()));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a rejected tag push fails deploy instead of continuing to draft creation', () => {
  const run = ((_command: string, args: string[]) => {
    if (args[0] === 'push') throw new Error('Tag creation denied');
    return Buffer.alloc(0);
  }) as typeof execFileSync;
  assert.throws(() => createVersionTag(candidate, hash, run), /Tag creation denied/);
});

test('every manual result must name the exact source and accepted bytes', () => {
  validateManualAcceptance(manual, sha, hash);
  for (const patch of [
    { sha: 'd'.repeat(40) },
    { candidateHash: 'd'.repeat(64) },
    { tester: '' },
    { checkedAt: 'not a date' },
    { results: {} },
  ]) {
    assert.throws(() => validateManualAcceptance({ ...manual, ...patch }, sha, hash));
  }
  for (const name of MANUAL_CHECKS) {
    for (const result of ['skipped', 'failed', 'not verified']) {
      assert.throws(() =>
        validateManualAcceptance(
          { ...manual, results: { ...manual.results, [name]: { result, evidence: 'A note' } } },
          sha,
          hash,
        ),
      );
    }
    assert.throws(() =>
      validateManualAcceptance(
        { ...manual, results: { ...manual.results, [name]: { result: 'passed', evidence: '' } } },
        sha,
        hash,
      ),
    );
  }
});

test('tagging requires attested source manifest and both packages from the pinned workflow', () => {
  const packaged = {
    ...candidate,
    files: {
      'FTPeach_0.6.1_x64-setup.exe': hash,
      'FTPeach_0.6.1_x64-portable.zip': hash,
      'release-notes.md': hash,
    },
  };
  const verified: string[] = [];
  const run = ((command: string, args: string[]) => {
    assert.equal(command, 'gh');
    const file = path.basename(args[2]!);
    assert.deepEqual(args.slice(0, 2), ['attestation', 'verify']);
    assert.deepEqual(args.slice(3), [
      '--repo',
      'owner/app',
      '--signer-workflow',
      'owner/app/.github/workflows/release.yml',
      '--signer-digest',
      candidate.build.workflowSha,
      '--format',
      'json',
    ]);
    verified.push(file);
    return Buffer.alloc(0);
  }) as typeof execFileSync;
  verifyAttestations('candidate', packaged, '.github/workflows/release.yml', run);
  assert.deepEqual(verified, [
    'candidate.json',
    'FTPeach_0.6.1_x64-setup.exe',
    'FTPeach_0.6.1_x64-portable.zip',
  ]);
  for (const rejected of verified) {
    const reject = ((_command: string, args: string[]) => {
      if (path.basename(args[2]!) === rejected) throw new Error('Attestation rejected');
      return Buffer.alloc(0);
    }) as typeof execFileSync;
    assert.throws(
      () => verifyAttestations('candidate', packaged, '.github/workflows/release.yml', reject),
      /Attestation rejected/,
    );
  }
});
test('only an annotated tag of these exact candidate bytes can be resumed', () => {
  const tag = {
    tag: 'v0.6.1',
    message: tagMessage('0.6.1', hash),
    object: { type: 'commit', sha },
  };
  validateTag(tag, candidate, hash);
  assert.throws(() => validateTag({ ...tag, tag: 'v0.6.0' }, candidate, hash));
  assert.throws(() =>
    validateTag({ ...tag, message: tagMessage('0.6.1', 'd'.repeat(64)) }, candidate, hash),
  );
  assert.throws(() =>
    validateTag({ ...tag, object: { type: 'commit', sha: 'd'.repeat(40) } }, candidate, hash),
  );
});
test('uploads resume only missing assets, and never overwrite mismatches or unproven hashes', () => {
  assert.equal(assetNeedsUpload(undefined, hash), true);
  assert.equal(
    assetNeedsUpload({ name: 'setup.exe', url: 'asset', digest: `sha256:${hash}` }, hash),
    false,
  );
  assert.throws(() =>
    assetNeedsUpload({ name: 'setup.exe', url: 'asset', digest: `sha256:${'d'.repeat(64)}` }, hash),
  );
  assert.throws(() => assetNeedsUpload({ name: 'setup.exe', url: 'asset' }, hash));
});
