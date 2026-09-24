import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MANUAL_CHECKS,
  gateOf,
  markerProblems,
  markers,
} from '../../../scripts/checks/check-verified-by.ts';

const rust = [
  '#[tokio::test]',
  'async fn resumes_unchanged_files() {}',
  '#[test]',
  '#[ignore = "needs Docker"]',
  'fn against_a_real_server() {}',
  'fn helper_not_a_test() {}',
].join('\n');

const typescript = [
  "test('a paused upload resumes', () => {});",
  "test.skip('a flaky scenario', () => {});",
].join('\n');

test('markers are read with their gate, target and line', () => {
  const guide = 'Text.\n<!-- verified-by: pr a.rs::one -->\n<!-- verified-by: manual Drag out -->';
  assert.deepEqual(markers(guide), [
    { line: 2, gate: 'pr', target: 'a.rs::one' },
    { line: 3, gate: 'manual', target: 'Drag out' },
  ]);
});

test('a running test is found; a missing, disabled or non-test one is not', () => {
  assert.equal(gateOf('src-tauri/src/x.rs', rust, 'resumes_unchanged_files'), 'pr');
  assert.match(gateOf('src-tauri/src/x.rs', rust, 'deleted_test'), /no test fn/);
  assert.match(gateOf('src-tauri/src/x.rs', rust, 'helper_not_a_test'), /no test fn/);
  assert.match(gateOf('src-tauri/src/x.rs', rust, 'against_a_real_server'), /no workflow runs/);
  assert.equal(gateOf('test/unit/a.test.ts', typescript, 'a paused upload resumes'), 'pr');
  assert.match(gateOf('test/unit/a.test.ts', typescript, 'a flaky scenario'), /switched off/);
  assert.match(gateOf('test/unit/a.test.ts', typescript, 'a paused upload'), /no test titled/);
});

test('an ignored Docker test runs weekly, and a marker must say so', async () => {
  const file = 'src-tauri/tests/docker_integration.rs';
  assert.equal(gateOf(file, rust, 'against_a_real_server'), 'weekly');
  const read = async () => rust;
  const target = `${file}::against_a_real_server`;
  assert.deepEqual(await markerProblems({ line: 1, gate: 'weekly', target }, read), []);
  const claimed = await markerProblems({ line: 1, gate: 'pr', target }, read);
  assert.match(claimed[0]!, /runs on weekly, not pr/);
});

test('a manual marker needs its recorded run', async () => {
  const read = async (file: string) =>
    file === MANUAL_CHECKS ? '# Manual checks\n\n### Drag out to Explorer\n' : undefined;
  assert.deepEqual(
    await markerProblems({ line: 5, gate: 'manual', target: 'Drag out to Explorer' }, read),
    [],
  );
  const missing = await markerProblems({ line: 5, gate: 'manual', target: 'Drag out' }, read);
  assert.match(missing[0]!, /no "Drag out" heading/);
});

test('an unknown gate or a missing file is reported', async () => {
  const read = async () => undefined;
  const [gate] = await markerProblems({ line: 1, gate: 'nightly', target: 'a.rs::x' }, read);
  assert.match(gate!, /not pr, weekly or manual/);
  const [file] = await markerProblems({ line: 1, gate: 'pr', target: 'gone.rs::x' }, read);
  assert.match(file!, /does not exist/);
});
