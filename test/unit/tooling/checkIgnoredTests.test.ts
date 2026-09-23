import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ignoredTests, isRegistered } from '../../../scripts/checks/check-ignored-tests.ts';

const source = [
  '    #[test]',
  '    #[ignore = "needs a second volume"]',
  '    fn cross_volume_move() {}',
  '    #[tokio::test]',
  '    #[ignore]',
  '    async fn silent() {}',
  '//! Every test is `#[ignore]`; this comment is not one.',
].join('\n');

test('an ignore attribute is read with its reason and the test it marks', () => {
  assert.deepEqual(ignoredTests('src-tauri/src/fs.rs', source), [
    {
      file: 'src-tauri/src/fs.rs',
      line: 2,
      name: 'cross_volume_move',
      reason: 'needs a second volume',
    },
    { file: 'src-tauri/src/fs.rs', line: 5, name: 'silent', reason: undefined },
  ]);
});

test('a test is registered by its name, its file or its folder, and only in backticks', () => {
  const marked = ignoredTests('src-tauri/tests/matrix/main.rs', source)[0]!;
  assert.equal(isRegistered(marked, '| `cross_volume_move` |'), true);
  assert.equal(isRegistered(marked, '| `src-tauri/tests/matrix/main.rs` |'), true);
  assert.equal(isRegistered(marked, '| `src-tauri/tests/matrix/` |'), true);
  assert.equal(isRegistered(marked, 'cross_volume_move without backticks'), false);
  assert.equal(isRegistered(marked, '| `cross_volume_move_later` |'), false);
});
