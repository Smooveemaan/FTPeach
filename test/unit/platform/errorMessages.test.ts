import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import i18n, { changeLanguage } from '../../../src/i18n/index.ts';
import {
  commandResultError,
  friendlyError,
  friendlyConnectError,
} from '../../../src/shared/errorMessages.ts';
import type { CommandErrorCode } from '../../../src/platform/ipcContracts.ts';

function assertFriendlyConnectMatches(
  raw: Parameters<typeof friendlyConnectError>[0],
  pattern: RegExp,
): void {
  const message = friendlyConnectError(raw);
  assert.ok(message);
  assert.match(message, pattern);
}

beforeEach(async () => {
  // Error helpers translate at call time. Select the language explicitly so
  // these tests are independent from App bootstrap and system locale.
  await i18n.changeLanguage('en');
});

test('friendlyError recognizes a real 530 login-failure reply', () => {
  // basic-ftp's Error message is the server's raw reply line, no prefix —
  // this is the shape session:connect actually surfaces.
  assert.equal(friendlyError('530 Login incorrect.'), 'Incorrect username or password.');
  // Multi-line reply: code at the start, followed by "-" on the first line.
  assert.equal(
    friendlyError('530-Please login with USER and PASS.'),
    'Incorrect username or password.',
  );
  // Preceded by other text, not just at the very start of the message.
  assert.equal(friendlyError('FTP error: 530 Not logged in.'), 'Incorrect username or password.');
});

test('friendlyError does not mislabel an unrelated message containing "530" as a substring', () => {
  assert.equal(
    friendlyError('Transfer failed after 530000 bytes'),
    'Transfer failed after 530000 bytes',
  );
  assert.equal(
    friendlyError('Cannot access /backup/2026-530/report.txt'),
    'Cannot access /backup/2026-530/report.txt',
  );
});

test('friendlyError still recognizes the other login-failure patterns', () => {
  assert.equal(friendlyError('Login incorrect'), 'Incorrect username or password.');
  assert.equal(
    friendlyError('All configured authentication methods failed'),
    'Incorrect username or password.',
  );
});

test('friendlyConnectError wraps an unrecognized error, passes a recognized one through', () => {
  assert.equal(friendlyConnectError('530 Login incorrect.'), 'Incorrect username or password.');
  assert.equal(
    friendlyConnectError('some unrecognized raw error'),
    "Couldn't connect to the server. some unrecognized raw error",
  );
});

test('structured command errors are localized by stable code without inspecting details', () => {
  assert.equal(
    friendlyError({
      code: 'connectionRefused',
      message: 'Command failed',
      details: 'arbitrary diagnostics that contain no recognizable English phrase',
    }),
    'The server refused the connection. Check the address and port.',
  );
  assert.equal(
    friendlyConnectError({ code: 'authFailed', message: 'Authentication failed' }),
    'Incorrect username or password.',
  );
  assertFriendlyConnectMatches(
    { code: 'tlsNegotiationFailed', message: 'TLS negotiation failed' },
    /^TLS negotiation failed\./,
  );
  assertFriendlyConnectMatches(
    { code: 'sshNegotiationFailed', message: 'SSH negotiation failed' },
    /^SSH negotiation failed\./,
  );
  assertFriendlyConnectMatches(
    { code: 'proxyFailed', message: 'Proxy connection failed' },
    /^The proxy connection failed\./,
  );
});

test('friendlyError localizes every structured command error code', () => {
  const expected = {
    authFailed: 'Incorrect username or password.',
    connectionRefused: 'The server refused the connection. Check the address and port.',
    timedOut:
      'The server is not responding (connection timed out). Check the address, port, and network connection.',
    hostKeyMismatch: 'The server host key has changed.',
    invalidCertificate:
      'The server presented an invalid certificate. If you trust this server, disable certificate verification in the connection settings.',
    tlsNegotiationFailed:
      'TLS negotiation failed. Check that the server supports explicit FTPS or HTTPS and a compatible TLS version.',
    sshNegotiationFailed:
      'SSH negotiation failed. The server and FTPeach could not agree on a compatible SSH algorithm or protocol version.',
    proxyFailed:
      'The proxy connection failed. Check the proxy type, address, credentials, and whether it can reach the target server.',
    notFound: 'File or folder not found.',
    permissionDenied: "You don't have permission for this operation.",
    cancelled: 'Cancelled by user',
    integrityMismatch: 'The transferred file failed the integrity check.',
    networkUnreachable: 'The server is unreachable — check your network connection.',
    connectionLost: 'The connection to the server was unexpectedly closed.',
    invalidInput: 'The provided value is invalid.',
    resourceLimit: 'The provided value is invalid.',
    vaultLocked: 'Unlock protected storage',
    internal: 'An unexpected error occurred.',
  } satisfies Record<CommandErrorCode, string>;

  for (const [code, message] of Object.entries(expected)) {
    assert.equal(friendlyError({ code, message: 'unlocalized backend fallback' }), message, code);
  }
});

test('commandResultError preserves the structured code used for localization', () => {
  assert.equal(
    friendlyError(
      commandResultError({
        error: 'Operation was not approved',
        errorCode: 'permissionDenied',
      }),
    ),
    "You don't have permission for this operation.",
  );
});

test('friendlyError recognizes Windows socket error codes reaching it via anyhow context chains', () => {
  assert.equal(
    friendlyError('TCP connect failed: Connection refused (os error 10061)'),
    'The server refused the connection. Check the address and port.',
  );
  assert.equal(
    friendlyError(
      'TCP connect failed: failed to lookup address information: No such host is known. (os error 11001)',
    ),
    'Server not found. Check that the address is correct.',
  );
  assert.equal(
    friendlyError('reading from server: Connection reset by peer (os error 10054)'),
    'The connection to the server was unexpectedly closed.',
  );
});

test('friendlyError covers every translated recognition branch', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    [
      'socket read failed (os error 10060)',
      'The server is not responding (connection timed out). Check the address, port, and network connection.',
    ],
    [
      'network route failed (os error 10051)',
      'The server is unreachable — check your network connection.',
    ],
    [
      'certificate verify failed',
      'The server presented an invalid certificate. If you trust this server, disable certificate verification in the connection settings.',
    ],
    [
      'Cannot parse privateKey',
      "Couldn't read the key — the file is corrupted or the passphrase is incorrect.",
    ],
    ['opening file failed (os error 5)', "You don't have permission for this operation."],
    ['550 Permission denied', "You don't have permission for this operation."],
    ['opening path failed (os error 2)', 'File or folder not found.'],
    ['creating file failed (os error 80)', 'A file or folder with that name already exists.'],
    ['opening file failed (os error 32)', 'The file is in use by another process.'],
    ['writing file failed (os error 112)', 'Not enough disk space.'],
  ];

  for (const [raw, expected] of cases) {
    assert.equal(friendlyError(raw), expected, raw);
  }
});

test('friendlyError still passes an unrelated message with a numeric suffix through unchanged', () => {
  // Guards against a careless numeric pattern swallowing unrelated text —
  // "os error 10061" must be the literal marker, not just any number.
  assert.equal(friendlyError('retried 10061 times'), 'retried 10061 times');
});

test('friendlyError matches the real host-key-mismatch text despite the host:port in the middle', () => {
  const raw =
    'The server key for 192.0.2.1:22 changed since the previous connection (expected SHA256 fingerprint aaa, received bbb). The connection was stopped.';
  assert.equal(friendlyError(raw), raw);
});

test('friendlyError supports a secondary Unicode locale', async () => {
  await changeLanguage('ru');

  assert.equal(
    friendlyError('530 Login incorrect.'),
    '\u041d\u0435\u0432\u0435\u0440\u043d\u044b\u0439 \u043b\u043e\u0433\u0438\u043d \u0438\u043b\u0438 \u043f\u0430\u0440\u043e\u043b\u044c.',
  );
});
