import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  authenticodeVerdict,
  environmentVerdict,
  ignoredAdvisories,
  parseAdvisoryRegister,
  privateKeyHits,
  rustsecKind,
} from '../../../scripts/release/release-trust.ts';

test('an unsigned binary is reported as the accepted state, not as signed', () => {
  const verdict = authenticodeVerdict('setup.exe', { status: 'NotSigned', timestamped: false });
  assert.equal(verdict.ok, true);
  assert.match(verdict.summary, /not Authenticode-signed/);
});

test('a signature that does not verify fails the release', () => {
  for (const status of ['HashMismatch', 'NotTrusted', 'UnknownError', 'NotSupportedFileFormat']) {
    assert.equal(authenticodeVerdict('setup.exe', { status, timestamped: true }).ok, false, status);
  }
});

test('a valid signature without a timestamp fails the release', () => {
  const verdict = authenticodeVerdict('setup.exe', {
    status: 'Valid',
    signer: 'CN=FTPeach',
    timestamped: false,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.summary, /no timestamp/);
});

test('a valid, timestamped signature passes and names its signer', () => {
  const verdict = authenticodeVerdict('setup.exe', {
    status: 'Valid',
    signer: 'CN=FTPeach',
    timestamped: true,
  });
  assert.deepEqual(verdict, {
    ok: true,
    summary: 'setup.exe: Authenticode-signed by CN=FTPeach, timestamped',
  });
});

test('naming the release environment is not the same as protecting it', () => {
  // The state the live repository was found in: no rules, bypass allowed.
  const verdict = environmentVerdict({ can_admins_bypass: true, protection_rules: [] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.summary, /no required reviewers/);
  assert.match(verdict.summary, /administrators can bypass/);
});

test('a wait timer or branch rule does not count as an approval', () => {
  const verdict = environmentVerdict({
    can_admins_bypass: false,
    protection_rules: [{ type: 'wait_timer' }, { type: 'branch_policy' }],
  });
  assert.equal(verdict.ok, false);
});

test('an unreported bypass setting is treated as bypass allowed', () => {
  const verdict = environmentVerdict({
    protection_rules: [{ type: 'required_reviewers', reviewers: [{}] }],
  });
  assert.equal(verdict.ok, false);
});

test('required reviewers without administrator bypass pass', () => {
  const verdict = environmentVerdict({
    can_admins_bypass: false,
    protection_rules: [{ type: 'required_reviewers', reviewers: [{}] }],
  });
  assert.equal(verdict.ok, true);
});

const keyFile =
  'untrusted comment: rsign encrypted secret key\nRWRTY0IyQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w\n';
const secret = Buffer.from(keyFile).toString('base64');

test('the updater key is found as given, decoded, or by its header', () => {
  assert.deepEqual(privateKeyHits(Buffer.from(`x${secret}x`), secret), ['the updater private key']);
  assert.deepEqual(
    privateKeyHits(
      Buffer.from('xRWRTY0IyQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wx'),
      secret,
    ),
    ['the decoded updater private key'],
  );
  assert.deepEqual(privateKeyHits(Buffer.from(keyFile), undefined), [
    'a "untrusted comment: rsign encrypted secret key" header',
  ]);
});

test('a clean file, or a missing or short secret, finds nothing', () => {
  assert.deepEqual(privateKeyHits(Buffer.from('MZ ordinary binary'), secret), []);
  assert.deepEqual(privateKeyHits(Buffer.from('MZ'), ''), []);
  assert.deepEqual(privateKeyHits(Buffer.from('MZ abc'), 'abc'), []);
});

test('RustSec class comes from the informational field, vulnerability otherwise', () => {
  assert.equal(
    rustsecKind('```toml\n[advisory]\ninformational = "unmaintained"\n```'),
    'unmaintained',
  );
  assert.equal(rustsecKind('```toml\n[advisory]\ninformational = "unsound"\n```'), 'unsound');
  assert.equal(rustsecKind('```toml\n[advisory]\ncvss = "CVSS:3.1/AV:N"\n```'), 'vulnerability');
  assert.equal(rustsecKind('```toml\n[advisory]\ninformational = "something-new"\n```'), undefined);
});

test('register rows and deny.toml ids are read by column', () => {
  const rows = parseAdvisoryRegister(
    '| Advisory | Kind |\n| --- | --- |\n| RUSTSEC-2023-0071 | vulnerability | @o | 2026-08-30 | 2026-11-30 | s | c |\n',
  );
  assert.deepEqual(rows.get('RUSTSEC-2023-0071'), {
    id: 'RUSTSEC-2023-0071',
    kind: 'vulnerability',
    owner: '@o',
    added: '2026-08-30',
    reviewBy: '2026-11-30',
    status: 's',
    control: 'c',
  });
  assert.deepEqual(
    ignoredAdvisories('ignore = [\n  { id = "RUSTSEC-2024-0436", reason = "x" },\n]'),
    ['RUSTSEC-2024-0436'],
  );
});
