import i18n from '../i18n/index.ts';
import type { CommandErrorCode } from '../platform/ipcContracts.ts';
import { lookupByUnknownKey } from './lang.ts';

const ERROR_CODE_KEYS = {
  authFailed: 'errors.loginIncorrect',
  connectionRefused: 'errors.connectionRefused',
  hostNotFound: 'errors.serverNotFound',
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
  cleanupIncomplete: 'errors.cleanupIncomplete',
  networkUnreachable: 'errors.networkUnreachable',
  connectionLost: 'errors.connectionReset',
  invalidInput: 'errors.invalidInput',
  resourceLimit: 'errors.invalidInput',
  storageFull: 'errors.diskFull',
  keyUnreadable: 'errors.keyReadFailed',
  credentialFileMissing: 'errors.credentialFileMissing',
  networkPathNotChosen: 'errors.networkPathNotChosen',
  busy: 'errors.locationBusy',
  fileInUse: 'errors.fileBusy',
  vaultLocked: 'settings.security.unlockRequired',
  vaultAuthFailed: 'settings.security.unlockRefused',
  savedSecretUnreadable: 'errors.savedSecretUnreadable',
  alreadyExists: 'errors.fileOrFolderExists',
  replaceUnsupported: 'errors.replaceUnsupported',
  createUnsupported: 'errors.createUnsupported',
  internal: 'errors.internal',
} as const satisfies Record<CommandErrorCode, string>;

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
    // The one code whose message is data: the path of the missing file.
    if (raw.code === 'credentialFileMissing')
      return i18n.t('errors.credentialFileMissing', { path: raw.message });
    return key ? i18n.t(key) : raw.message || raw.code;
  }
  return raw;
}

/** What is wrong with a WebDAV address, as the backend would refuse it, or null. */
export function webdavUrlError(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return i18n.t('errors.webdavUrlNotAbsolute');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname)
    return i18n.t('errors.webdavUrlNotAbsolute');
  if (url.username || url.password) return i18n.t('errors.webdavUrlCredentials');
  if (url.search || url.hash || address.includes('?') || address.includes('#'))
    return i18n.t('errors.webdavUrlQuery');
  return null;
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
