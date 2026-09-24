import assert from 'node:assert/strict';
import test from 'node:test';
import { docImpactProblems, readExemptions } from '../../../scripts/checks/check-doc-impact.ts';

const none = { docs: undefined, changelog: undefined };

test('a behavior change without its document or a reason is caught', () => {
  const problems = docImpactProblems(['src-tauri/src/protocol/ftp.rs', 'CHANGELOG.md'], none);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /protocol\/ftp\.rs changed.*docs\/protocol-support\.md/);
});

test('updating any linked document satisfies the link', () => {
  const paths = ['src-tauri/src/protocol/ftp.rs', 'docs/user-guide.md', 'CHANGELOG.md'];
  assert.deepEqual(docImpactProblems(paths, none), []);
});

test('a refactor passes with a stated reason, and a bare "none" is not a reason', () => {
  const refactor = readExemptions(
    'Split the FTP reply parser\n\nDocs-Impact: none - internal refactor\nChangelog: none — nothing users see\n',
  );
  assert.deepEqual(refactor, {
    docs: 'internal refactor',
    changelog: 'nothing users see',
  });
  assert.deepEqual(docImpactProblems(['src-tauri/src/protocol/ftp.rs'], refactor), []);
  assert.deepEqual(readExemptions('Docs-Impact: none\nChangelog: none -\n'), none);
});

test('the changelog is owed separately from the guide', () => {
  const fix = readExemptions('Docs-Impact: none - restores the behavior the guide describes');
  const problems = docImpactProblems(['src-tauri/src/protocol/transfer_file.rs'], fix);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /CHANGELOG\.md did not/);
  assert.deepEqual(
    docImpactProblems(['src-tauri/src/protocol/transfer_file.rs', 'CHANGELOG.md'], fix),
    [],
  );
});

test('tests, tooling and docs alone owe nothing', () => {
  const paths = [
    'src-tauri/src/protocol/ftp_tests.rs',
    'src-tauri/src/store/tests.rs',
    'src-tauri/tests/server_matrix/scenarios.rs',
    'test/unit/tooling/checkDocImpact.test.ts',
    'scripts/checks/check-doc-impact.ts',
    'docs/architecture.md',
  ];
  assert.deepEqual(docImpactProblems(paths, none), []);
});

test('a frontend change owes a changelog line but no linked document', () => {
  const problems = docImpactProblems(['src/features/transfers/useTransfers.ts'], none);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /CHANGELOG\.md did not/);
});
