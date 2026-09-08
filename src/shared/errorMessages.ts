import i18n from '../i18n/index.ts';
import type { CommandErrorCode } from '../platform/ipcContracts.ts';
import { lookupByUnknownKey } from './lang.ts';

const ERROR_CODE_KEYS = {
  authFailed: 'errors.loginIncorrect',
  connectionRefused: 'errors.connectionRefused',
  timedOut: 'errors.timeout',
  hostKeyMismatch: 'errors.hostKeyMismatch',
  invalidCertificate: 'errors.invalidCertificate',
  tlsNegotiationFailed: 'errors.tlsNegotiationFailed',
  sshNegotiationFailed: 'errors.sshNegotiationFailed',
  proxyFailed: 'errors.proxyFailed',
  notFound: 'errors.notFound',
  permissionDenied: 'errors.accessDenied',
  cancelled: 'transferQueue.cancelledByUser',
  integrityMismatch: 'errors.integrityMismatch',
  networkUnreachable: 'errors.networkUnreachable',
  connectionLost: 'errors.connectionReset',
  invalidInput: 'errors.invalidInput',
  resourceLimit: 'errors.invalidInput',
  vaultLocked: 'settings.security.unlockRequired',
  internal: 'errors.internal',
} as const satisfies Record<CommandErrorCode, string>;

const PATTERNS = [
  {
    // WSAECONNREFUSED — nothing listening on host:port, or a firewall
    // actively rejecting the connection.
    test: /os error 10061/i,
    key: 'errors.connectionRefused',
  },
  {
    // WSAHOST_NOT_FOUND / WSANO_DATA, or the DNS-lookup context Rust's own
    // resolver wraps such failures in regardless of the OS message's locale.
    test: /os error 11001|os error 11004|failed to lookup address information/i,
    key: 'errors.serverNotFound',
  },
  {
    test: /os error 10060/i,
    key: 'errors.timeout',
  },
  {
    // WSAECONNRESET / WSAECONNABORTED / WSAENETRESET — the connection was up
    // and then wasn't, from either side.
    test: /os error 10054|os error 10053|os error 10052/i,
    key: 'errors.connectionReset',
  },
  {
    // WSAENETUNREACH / WSAENETDOWN / WSAEHOSTUNREACH.
    test: /os error 10051|os error 10050|os error 10065/i,
    key: 'errors.networkUnreachable',
  },
  {
    test: /(?:^|\s)530[ -]|login incorrect|auth fail|all configured authentication methods failed|password auth failed|key auth failed|Invalid response: 401|Invalid response: 403/i,
    key: 'errors.loginIncorrect',
  },
  {
    test: /HOST_KEY_MISMATCH|The server key[\s\S]*changed/i,
    key: null,
  },
  {
    test: /certificate|CERT_|SELF_SIGNED|unable to verify the first certificate/i,
    key: 'errors.invalidCertificate',
  },
  {
    // russh's key-loading error when a key file's contents don't parse —
    // wrong/missing passphrase, or a corrupt/non-key file selected.
    test: /Cannot parse privateKey|could not read the key file/i,
    key: 'errors.keyReadFailed',
  },
  {
    // Local filesystem access errors (ERROR_ACCESS_DENIED) surfaced by
    // commands/fs.rs — a read-only file, a permissions-restricted folder.
    test: /os error 5\b/i,
    key: 'errors.accessDenied',
  },
  {
    test: /no permission|permission denied/i,
    key: 'errors.accessDenied',
  },
  {
    test: /os error 2\b|os error 3\b/i,
    key: 'errors.notFound',
  },
  {
    // ERROR_FILE_EXISTS / ERROR_ALREADY_EXISTS.
    test: /os error 80\b|os error 183\b/i,
    key: 'errors.fileOrFolderExists',
  },
  {
    // ERROR_SHARING_VIOLATION — a local file another process has open
    // exclusively (common on Windows for a file mid-copy/mid-edit).
    test: /os error 32\b/i,
    key: 'errors.fileBusy',
  },
  {
    // ERROR_DISK_FULL / ERROR_HANDLE_DISK_FULL.
    test: /os error 112\b|os error 39\b/i,
    key: 'errors.diskFull',
  },
];

interface FriendlyErrorValue {
  code?: string | undefined;
  message?: string | undefined;
  details?: string | undefined;
}

export type FriendlyErrorInput = string | FriendlyErrorValue | null | undefined;

export function commandResultError(result: {
  error?: string | undefined;
  errorCode?: string | undefined;
}): FriendlyErrorInput {
  return result.errorCode ? { code: result.errorCode, message: result.error } : result.error;
}

export function friendlyError(raw: FriendlyErrorInput): string | null | undefined {
  if (!raw) return raw;
  if (typeof raw === 'object') {
    const key = lookupByUnknownKey(ERROR_CODE_KEYS, raw.code);
    return key ? i18n.t(key) : raw.message || raw.code;
  }
  for (const { test, key } of PATTERNS) {
    if (test.test(raw)) return key ? i18n.t(key) : raw;
  }
  return raw;
}

export function friendlyConnectError(raw: FriendlyErrorInput): string | null | undefined {
  if (!raw) return raw;
  if (typeof raw === 'object') {
    const friendly = friendlyError(raw);
    return friendly !== (raw.message || raw.code)
      ? friendly
      : i18n.t('errors.connectFailedPrefix', { raw: raw.message || raw.code });
  }
  const friendly = friendlyError(raw);
  if (friendly !== raw) return friendly;
  return i18n.t('errors.connectFailedPrefix', { raw });
}
