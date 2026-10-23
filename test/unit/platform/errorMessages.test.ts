import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import i18n, { changeLanguage } from '../../../src/i18n/index.ts';
import {
  isStorageWarnings,
  storageWarningText,
  commandResultError,
  friendlyError,
  friendlyConnectError,
  webdavUrlError,
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
    /^Couldn't set up encryption \(TLS\)/,
  );
  assertFriendlyConnectMatches(
    { code: 'sshNegotiationFailed', message: 'SSH negotiation failed' },
    /no SSH algorithm in common\.$/,
  );
  assertFriendlyConnectMatches(
    { code: 'proxyFailed', message: 'Proxy connection failed' },
    /^Couldn't connect through the proxy\.$/,
  );
});

test('friendlyError localizes every structured command error code', () => {
  const expected = {
    authFailed: 'Incorrect username or password.',
    connectionRefused: 'The server refused the connection. Check the address and port.',
    hostNotFound: 'Server not found. Check that the address is correct.',
    timedOut: "The server isn't responding. Check the address, port and network.",
    hostKeyMismatch: "The server's host key has changed, so FTPeach didn't connect.",
    invalidCertificate: "The server's certificate isn't valid.",
    tlsNegotiationFailed: "Couldn't set up encryption (TLS) with the server.",
    sshNegotiationFailed: 'The server and FTPeach have no SSH algorithm in common.',
    proxyFailed: "Couldn't connect through the proxy.",
    notFound: 'File or folder not found.',
    permissionDenied: "You don't have permission for this operation.",
    cancelled: 'Cancelled by user',
    integrityMismatch: "A file changed during the transfer or couldn't be checked.",
    cleanupIncomplete: "Some files were kept: FTPeach couldn't confirm it created them.",
    networkUnreachable: 'The server is unreachable — check your network connection.',
    connectionLost: 'The connection to the server was unexpectedly closed.',
    invalidInput: 'An unexpected error occurred.',
    resourceLimit: 'Too many connections or requests, or too much data. Try again later.',
    storageFull: 'Not enough free space.',
    keyUnreadable: "Couldn't read the key — the file is corrupted or the passphrase is incorrect.",
    credentialFileMissing:
      'The key or certificate file was not found: unlocalized backend fallback',
    networkPathNotChosen:
      'FTPeach opens a network path only after you choose it in a dialog, such as Choose folder…',
    busy: 'Another operation is already working with this file or folder. Try again once it finishes.',
    fileInUse: 'The file is open in another program.',
    vaultLocked: 'Unlock vault',
    vaultAuthFailed: 'The master password was not accepted. Wait a moment before trying again.',
    vaultUnreadable:
      'The password vault could not be read or saved. Your master password was not counted as wrong.',
    savedSecretUnreadable:
      "A saved password can't be read on this computer. Enter it again in the bookmark or in the proxy settings.",
    alreadyExists: 'A file or folder with that name already exists.',
    replaceUnsupported: "The server didn't allow the existing file to be replaced.",
    replaceInterrupted:
      'The connection was lost while replacing the file. The old version will be restored on the next connection.',
    stagingLeft:
      'The temporary file unlocalized backend fallback could not be deleted from the server.',
    createUnsupported:
      'This FTP server does not support creating new files. Try SFTP or WebDAV if the server offers them.',
    activeModeFailed: "The server couldn't connect back in active FTP mode. Try passive mode.",
    linkNotFollowed:
      "The path goes through a link (a junction or symbolic link). Links aren't followed.",
    noRecycleBin: 'This location has no Recycle Bin, so nothing was deleted.',
    storeNewer: "This data was saved by a newer version of FTPeach, so the change can't be saved.",
    storeUnreadable: "The file that keeps this data can't be read, so the change can't be saved.",
    storeNotWritable:
      "Couldn't save changes in unlocalized backend fallback: FTPeach isn't allowed to write to this folder.",
    sourceChanged:
      "The file changed while it was uploading, so the server's copy was left as it was. Upload it again.",
    remoteChanged:
      'The file on the server changed while it was downloading, so the file on this computer was left as it was. Download it again.',
    invalidFileName: 'Windows doesn\'t allow the name "unlocalized backend fallback".',
    insideSource: "A folder can't be copied or moved into itself.",
    webdavRedirect: 'The server redirects to another address: unlocalized backend fallback',
    cleartextSignIn:
      'The server asks for a password over an unencrypted connection. Use https:// or allow unencrypted sign-in.',
    editsRetained:
      'Edits that were not uploaded take over 1 GB or are over 30 days old. Upload or delete them first.',
    resumeExpired: "This paused transfer can't be resumed. Start it again.",
    programUnavailable: "The program wasn't found or can't be run.",
    secretNotProtected: "The password couldn't be encrypted, so the change wasn't saved.",
    serverRefused: 'The server refused: unlocalized backend fallback',
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

test('a WebDAV address says what is wrong with it', () => {
  assert.match(webdavUrlError('dav.example.com') ?? '', /http:\/\//);
  assert.match(webdavUrlError('https://user:pw@dav.example.com') ?? '', /user name and password/);
  assert.match(webdavUrlError('https://dav.example.com/?a=1') ?? '', /\? or #/);
  assert.equal(webdavUrlError('https://dav.example.com/files'), null);
});

test('a missing key or certificate is named by its path', () => {
  assert.equal(
    friendlyError({ code: 'credentialFileMissing', message: 'C:/keys/id_ed25519' }),
    'The key or certificate file was not found: C:/keys/id_ed25519',
  );
});

test('storage warnings at start name the file and say what it means, in the interface language', () => {
  const warnings = [
    { file: 'settings.json', code: 'replaced' },
    { file: 'sites.json', code: 'newer' },
  ];
  assert.ok(isStorageWarnings(warnings));
  assert.equal(
    storageWarningText(warnings as never),
    "settings.json couldn't be read. FTPeach kept a copy of it and started without its contents; your next change saves a new one.\n" +
      "sites.json was saved by a newer version of FTPeach, so changes to it can't be saved.",
  );
  // Backend text from an older build is not shown raw.
  assert.ok(!isStorageWarnings(['settings.json: parsing JSON']));
});
