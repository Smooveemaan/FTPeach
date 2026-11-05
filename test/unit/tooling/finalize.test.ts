import assert from 'node:assert/strict';
import { type execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import {
  assetNeedsUpload,
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
