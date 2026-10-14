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
  resourceLimit: 'errors.resourceLimit',
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
  replaceInterrupted: 'errors.replaceInterrupted',
  stagingLeft: 'errors.stagingLeft',
  createUnsupported: 'errors.createUnsupported',
  activeModeFailed: 'errors.activeModeFailed',
  linkNotFollowed: 'errors.linkNotFollowed',
  noRecycleBin: 'errors.noRecycleBin',
  storeNewer: 'errors.storeNewer',
  storeUnreadable: 'errors.storeUnreadable',
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
    // The codes whose message is data: the path of the file concerned.
    if (raw.code === 'credentialFileMissing' || raw.code === 'stagingLeft')
      return i18n.t(`errors.${raw.code}`, { path: raw.message });
    return key ? i18n.t(key) : raw.message || raw.code;
  }
  return raw;
}

const STORAGE_WARNING_CODES = [
  'recovered',
  'replaced',
  'unreadable',
  'newer',
  'backupNotUpdated',
] as const;

/** A file of FTPeach's own data that is not as it was saved, as the backend reports it. */
export interface StorageWarning {
  file: string;
  code: (typeof STORAGE_WARNING_CODES)[number];
}

export function isStorageWarnings(value: unknown): value is StorageWarning[] {
  return (
    Array.isArray(value) &&
    value.every(
      (warning: unknown) =>
        typeof warning === 'object' &&
        warning !== null &&
        typeof (warning as StorageWarning).file === 'string' &&
        (STORAGE_WARNING_CODES as readonly unknown[]).includes((warning as StorageWarning).code),
    )
  );
}

/** One line per warning, in the interface language. */
export function storageWarningText(warnings: readonly StorageWarning[]): string {
  return warnings
    .map((warning) => i18n.t(`storageWarnings.${warning.code}`, { file: warning.file }))
    .join('\n');
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
