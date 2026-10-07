import assert from 'node:assert/strict';
import test from 'node:test';
import { failuresOf, outcomesOf, reportOf } from '../../../scripts/test-servers/ci.ts';

// libtest output as servers:ci sees it with --nocapture: a test's own lines can
// land before its result or glued right after it.
const output = [
  'test common::vsftpd::s04_transfer ... ok',
  'test common::dropbear::s04_transfer ... okNOT SELECTED [common::dropbear::s04_transfer]: dropbear is not selected',
  'test common::proftpd::s04_transfer ... NOT RUN [common::proftpd::s04_transfer]: skipped itself',
  'ok',
  'test specific::vsftpd_active_mode ... NOT RUN [specific::vsftpd_active_mode]: Linux Docker only',
  'ok',
  'test common::pureftpd::s04_transfer ... FAILED',
  '',
].join('\n');
const members = [
  'common::vsftpd::s04_transfer',
  'common::dropbear::s04_transfer',
  'common::proftpd::s04_transfer',
  'specific::vsftpd_active_mode',
  'common::pureftpd::s04_transfer',
  'common::nginx::s04_transfer',
];

test('a scenario that skipped itself fails the run; one outside the selection does not', () => {
  const outcomes = outcomesOf(output, members, false);
  assert.deepEqual(Object.fromEntries(outcomes), {
    'common::vsftpd::s04_transfer': 'passed',
    'common::dropbear::s04_transfer': 'not selected',
    'common::proftpd::s04_transfer': 'not run',
    'specific::vsftpd_active_mode': 'not run',
    'common::pureftpd::s04_transfer': 'failed',
    // No result line at all: the process died without saying.
    'common::nginx::s04_transfer': 'failed',
  });
  assert.deepEqual(
    failuresOf(outcomes, 'linux').map(([name]) => name),
    [
      'common::proftpd::s04_transfer',
      'specific::vsftpd_active_mode',
      'common::pureftpd::s04_transfer',
      'common::nginx::s04_transfer',
    ],
  );
});

test('active-mode FTP may skip itself only where Docker cannot route back', () => {
  const outcomes = outcomesOf(output, members, false);
  const failed = (platform: typeof process.platform) =>
    failuresOf(outcomes, platform).some(([name]) => name === 'specific::vsftpd_active_mode');
  assert.equal(failed('linux'), true);
  assert.equal(failed('win32'), false);
  assert.equal(failed('darwin'), false);
});

test('a run cut off by its time limit names the scenarios it never finished', () => {
  const outcomes = outcomesOf(
    'test common::a::s01 ... ok\n',
    ['common::a::s01', 'common::a::s02'],
    true,
  );
  assert.equal(outcomes.get('common::a::s02'), 'timed out');
  assert.deepEqual(failuresOf(outcomes, 'linux'), [['common::a::s02', 'timed out']]);
});

test('the report counts only selected servers and says how many tests it left out', () => {
  const outcomes = outcomesOf(output, members, false);
  const report = reportOf(['ftp'], outcomes, failuresOf(outcomes, 'linux'));
  assert.doesNotMatch(report, /\| dropbear \|/);
  assert.match(report, /\| proftpd \| 0 \| 0 \| 0 \| 1 \|/);
  assert.match(report, /1 test\(s\) belong to servers this run did not select/);
  assert.match(report, /- `common::proftpd::s04_transfer` \(not run\)/);
});
