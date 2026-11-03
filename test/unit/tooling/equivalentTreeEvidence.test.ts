import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateEquivalentTree,
  expectedCheckNames,
  type EvidenceInput,
} from '../../../scripts/checks/equivalent-tree-evidence.ts';
import type { GateId } from '../../../scripts/checks/classify-changes.ts';

const GATES: GateId[] = ['supply-chain', 'lint-test-build', 'rust-test-unix', 'packaged-smoke'];

function fixture(): EvidenceInput {
  return {
    before: 'base',
    classification: {
      requiredGates: GATES.map((id) => ({ id })),
    },
    currentTree: 'tree',
    head: 'merge',
    jobs: expectedCheckNames(GATES).map((name) => ({
      conclusion: 'success',
      name,
      status: 'completed',
    })),
    pullRequest: {
      base: { sha: 'base' },
      head: { sha: 'head' },
      merge_commit_sha: 'merge',
      merged_at: '2026-11-03T21:32:06Z',
      number: 14,
    },
    pullRequestTree: 'tree',
    run: {
      conclusion: 'success',
      event: 'pull_request',
      head_sha: 'head',
      id: 41718032763,
      path: '.github/workflows/ci.yml',
      status: 'completed',
    },
  };
}

test('a merged pull request with the same base and tree supplies complete CI evidence', () => {
  const decision = evaluateEquivalentTree(fixture());
  assert.equal(decision.reuse, true);
  assert.equal(decision.pullRequest, 14);
  assert.equal(decision.runId, 41718032763);
});

test('different bases or trees never reuse pull request results', () => {
  for (const change of [{ before: 'other-base' }, { currentTree: 'other-tree' }]) {
    const decision = evaluateEquivalentTree({ ...fixture(), ...change });
    assert.equal(decision.reuse, false);
  }
});

test('a different merge commit, an unmerged pull request or a non-PR run is not evidence', () => {
  const original = fixture();
  const cases = [
    { head: 'another-merge' },
    { pullRequest: { ...original.pullRequest, merged_at: null } },
    { run: { ...original.run, event: 'push' } },
    { run: { ...original.run, head_sha: 'another-head' } },
    { run: { ...original.run, path: '.github/workflows/other.yml' } },
  ];
  for (const change of cases) {
    assert.equal(evaluateEquivalentTree({ ...original, ...change }).reuse, false);
  }
});

test('missing, failed, cancelled and incomplete required jobs block reuse', () => {
  const original = fixture();
  const cases = [
    [],
    original.jobs.map((job, index) => (index === 0 ? { ...job, conclusion: 'failure' } : job)),
    original.jobs.map((job, index) => (index === 1 ? { ...job, conclusion: 'cancelled' } : job)),
    original.jobs.map((job, index) =>
      index === 2 ? { ...job, status: 'in_progress', conclusion: null } : job,
    ),
  ];
  for (const jobs of cases) {
    const decision = evaluateEquivalentTree({ ...original, jobs });
    assert.equal(decision.reuse, false);
    assert.match(decision.reason, /required pull request checks/);
  }
});

test('matrix evidence names every required operating system', () => {
  assert.deepEqual(expectedCheckNames(['packaged-smoke', 'rust-test-unix']), [
    'checks / packaged-smoke (windows-latest)',
    'checks / packaged-smoke (ubuntu-22.04)',
    'checks / packaged-smoke (macos-15)',
    'checks / rust-test-unix (ubuntu-22.04)',
    'checks / rust-test-unix (macos-15)',
  ]);
});
