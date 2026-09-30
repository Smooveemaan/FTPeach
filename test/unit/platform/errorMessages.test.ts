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

test('a message without a code is shown as it is, never read for one', () => {
  for (const raw of [
    '530 Login incorrect.',
    'TCP connect failed: No such host is known. (os error 11001)',
    'opening file failed (os error 32)',
    'Transfer failed after 530000 bytes',
    'retried 10061 times',
  ]) {
    assert.equal(friendlyError(raw), raw);
  }
});

test('friendlyConnectError wraps an untranslated error, passes a translated one through', () => {
  assert.equal(
    friendlyConnectError({ code: 'hostNotFound', message: 'Server not found' }),
    'Server not found. Check that the address is correct.',
  );
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
    hostNotFound: 'Server not found. Check that the address is correct.',
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
    cleanupIncomplete:
      'Cleanup is incomplete. Files whose ownership could not be verified were kept. Review the destination before removing them manually.',
    networkUnreachable: 'The server is unreachable — check your network connection.',
    connectionLost: 'The connection to the server was unexpectedly closed.',
    invalidInput: 'The provided value is invalid.',
    resourceLimit: 'The provided value is invalid.',
    storageFull: 'Not enough disk space.',
    keyUnreadable: "Couldn't read the key — the file is corrupted or the passphrase is incorrect.",
    busy: 'Another operation is already working with this file or folder. Try again once it finishes.',
    fileInUse: 'The file is in use by another process.',
    vaultLocked: 'Unlock vault',
    alreadyExists: 'A file or folder with that name already exists.',
    replaceUnsupported: "The server didn't allow the existing file to be replaced.",
    createUnsupported:
      'This FTP server does not support creating new files. Try SFTP or WebDAV if the server offers them.',
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

test('friendlyError matches the real host-key-mismatch text despite the host:port in the middle', () => {
  const raw =
    'The server key for 192.0.2.1:22 changed since the previous connection (expected SHA256 fingerprint aaa, received bbb). The connection was stopped.';
  assert.equal(friendlyError(raw), raw);
});

test('friendlyError supports a secondary Unicode locale', async () => {
  await changeLanguage('ru');

  assert.equal(
    friendlyError({ code: 'authFailed', message: 'Authentication failed' }),
    '\u041d\u0435\u0432\u0435\u0440\u043d\u044b\u0439 \u043b\u043e\u0433\u0438\u043d \u0438\u043b\u0438 \u043f\u0430\u0440\u043e\u043b\u044c.',
  );
});
