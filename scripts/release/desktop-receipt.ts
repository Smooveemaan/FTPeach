import assert from 'node:assert/strict';

export const DESKTOP_SCENARIOS = ['portable', 'shell', 'notification'] as const;
export interface DesktopReceipt {
  schema: number;
  candidateId: string;
  candidateHash: string;
  applicationSha: string;
  parentRunId: string;
  publicToolsSha: string;
  toolsSha: string;
  runId: string;
  attempt: string;
  results: {
    scenario: string;
    status: string;
    exitCode: number;
    disposable: boolean;
    webView2: string;
  }[];
}

export function collectDesktopFragments(
  fragments: DesktopReceipt[],
  identity: Omit<DesktopReceipt, 'results'>,
): DesktopReceipt {
  const selected = new Map<string, DesktopReceipt>();
  for (const fragment of fragments) {
    for (const key of [
      'schema',
      'candidateId',
      'candidateHash',
      'applicationSha',
      'parentRunId',
      'publicToolsSha',
      'toolsSha',
      'runId',
    ] as const)
      assert.equal(fragment[key], identity[key]);
    assert.match(fragment.attempt, /^[1-9][0-9]*$/);
    assert.ok(Number(fragment.attempt) <= Number(identity.attempt));
    assert.equal(fragment.results.length, 1);
    const scenario = fragment.results[0]!.scenario;
    const previous = selected.get(scenario);
    assert.notEqual(previous?.attempt, fragment.attempt, 'Ambiguous desktop fragment');
    if (!previous || Number(fragment.attempt) > Number(previous.attempt))
      selected.set(scenario, fragment);
  }
  const receipt = {
    ...identity,
    results: [...selected.values()].flatMap((fragment) => fragment.results),
  };
  validateDesktopReceipt(receipt, identity, {
    id: Number(identity.runId),
    run_attempt: Number(identity.attempt),
    head_sha: identity.toolsSha,
  });
  return receipt;
}

export function validateDesktopReceipt(
  receipt: DesktopReceipt,
  expected: Pick<
    DesktopReceipt,
    'candidateId' | 'candidateHash' | 'applicationSha' | 'parentRunId' | 'publicToolsSha'
  >,
  run: { id: number; run_attempt: number; head_sha: string },
) {
  assert.equal(receipt.schema, 1);
  for (const key of [
    'candidateId',
    'candidateHash',
    'applicationSha',
    'parentRunId',
    'publicToolsSha',
  ] as const)
    assert.equal(receipt[key], expected[key]);
  assert.equal(receipt.runId, String(run.id));
  assert.equal(receipt.attempt, String(run.run_attempt));
  assert.equal(receipt.toolsSha, run.head_sha);
  assert.deepEqual(
    receipt.results.map((result) => result.scenario).sort(),
    [...DESKTOP_SCENARIOS].sort(),
  );
  for (const result of receipt.results) {
    assert.equal(result.status, 'passed');
    assert.equal(result.exitCode, 0);
    assert.equal(result.disposable, true);
    assert.match(result.webView2, /^\d+\.\d+\.\d+\.\d+$/);
  }
}
