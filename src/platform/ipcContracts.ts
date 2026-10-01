import type { FileEntry } from '../shared/paneContracts.ts';
import type { LogEntry } from '../shared/logEntry.ts';
import type { SiteProtocol } from '../shared/siteContracts.ts';

const SITE_PROTOCOLS: readonly SiteProtocol[] = ['ftp', 'ftps', 'sftp', 'webdav'];

/**
 * Every failure code a command can report: `ipc::ErrorCode` in the backend,
 * which is the authority. `errorCodeParity.test.ts` fails when the two differ.
 */
export const COMMAND_ERROR_CODES = [
  'authFailed',
  'connectionRefused',
  'hostNotFound',
  'timedOut',
  'hostKeyMismatch',
  'invalidCertificate',
  'tlsNegotiationFailed',
  'sshNegotiationFailed',
  'proxyFailed',
  'notFound',
  'permissionDenied',
  'cancelled',
  'integrityMismatch',
  'cleanupIncomplete',
  'networkUnreachable',
  'connectionLost',
  'invalidInput',
  'resourceLimit',
  'storageFull',
  'keyUnreadable',
  'busy',
  'fileInUse',
  'vaultLocked',
  'vaultAuthFailed',
  'savedSecretUnreadable',
  'alreadyExists',
  'replaceUnsupported',
  'createUnsupported',
  'internal',
] as const;
export type CommandErrorCode = (typeof COMMAND_ERROR_CODES)[number];

export interface CommandError {
  code: CommandErrorCode;
  message: string;
  details?: string | undefined;
}

/**
 * A failed command raised as a rejection, keeping the code alongside the
 * message. A caller that has to tell one failure from another — a cancelled
 * confirmation from a store that would not write — cannot do it by matching
 * the backend's English text.
 */
export class CommandFailure extends Error {
  readonly code: CommandErrorCode;
  constructor(message: string, code: CommandErrorCode) {
    super(message);
    this.name = 'CommandFailure';
    this.code = code;
  }
}

/** Whether a rejection is the user having declined a confirmation. */
export function isCancellation(error: unknown): boolean {
  return error instanceof CommandFailure && error.code === 'cancelled';
}
export interface CommandResult {
  ok: boolean;
  error?: string | undefined;
  errorCode?: CommandErrorCode | undefined;
  diagnosticDetails?: string | undefined;
}
export interface TransferProgress {
  id: string;
  connectionId: string;
  status: 'progress' | 'done' | 'error';
  bytes?: number;
  total?: number;
  error?: string;
  errorCode?: string;
  /** How many folders and files a folder walk has put in place on its target so far. */
  landed?: number;
}
/**
 * A remote file dropped onto Explorer (native drag-out) has started
 * downloading. Unlike every other transfer, the frontend doesn't start this
 * one — the OS does, whenever it decides to pull the file's bytes — so the
 * backend announces it, and the Transfers panel adds a row from this. Later
 * updates arrive as ordinary {@link TransferProgress} events under `id`.
 */
export interface DragOutTransferStarted {
  isDirectory?: boolean | undefined;
  id: string;
  connectionId: string;
  protocol: SiteProtocol;
  name: string;
  remoteFile: string;
  total?: number;
}
export interface PreviewProgress {
  id: string;
  connectionId: string;
  bytes: number;
  total: number;
}
export type UpdaterStatus =
  | { state: 'checking' | 'not-available' | 'not-packaged' }
  | { state: 'downloading'; version: string; percent?: number }
  | { state: 'available' | 'downloaded'; version: string }
  | { state: 'error'; message: string };
/** A host key a connection refused, and what the user has to decide about. */
export interface HostKeyDecision {
  host: string;
  port: number;
  /** The pinned fingerprint, absent on a first connection. */
  expected?: string;
  actual: string;
}

export interface OpenWithChange {
  id: string;
  /** The revision to hand back once exactly this content is uploaded. */
  revision: string;
}

/**
 * The most transfers the `concurrency` setting may allow at once: the upper
 * bound in the backend's settings schema (`store/settings_schema.rs`), which
 * is the authority. `errorCodeParity.test.ts` fails when the two differ.
 */
export const MAX_TRANSFER_CONCURRENCY = 128;

/**
 * The most connections a bookmark may limit itself to; `MAX_SITE_CONNECTIONS`
 * in the backend's `protocol/config.rs` is the authority, checked by the same test.
 */
export const MAX_SITE_CONNECTIONS = 128;

/** Why the vault locked: on its own, or because the user asked (`user`). */
export const VAULT_LOCK_REASONS = ['idle', 'sessionLocked', 'windowHidden', 'user'] as const;
export type VaultLockReason = (typeof VAULT_LOCK_REASONS)[number];
export interface VaultLocked {
  reason: VaultLockReason;
}

/** An external-editor edit an earlier run could not upload. */
export interface RecoveredEdit {
  name: string;
  remotePath: string | null;
  savedAt: string;
}

export type InvokeArgs = Record<string, unknown>;
export type InvokeResult<T = unknown> = T | CommandResult;
export type InvokeFn = <T = unknown>(
  command: string,
  args?: InvokeArgs,
) => Promise<InvokeResult<T>>;
export type PayloadGuard<T> = (value: unknown) => value is T;
/**
 * Stops an event subscription. `ready` settles once the listener is in place:
 * `true` from then on every event reaches the callback, `false` if the
 * subscription failed (already reported) or was stopped first. It never
 * rejects. A consumer that also reads a snapshot reads it after `ready`, so no
 * event can fall between the snapshot and the listener.
 */
export type Unsubscribe = (() => void) & { readonly ready: Promise<boolean> };
export type EventSubscription<T> = (callback: (payload: T) => void) => Unsubscribe;

/** An {@link Unsubscribe} for a listener that is in place synchronously. */
export function readyUnsubscribe(stop: () => void): Unsubscribe {
  return Object.assign(stop, { ready: Promise.resolve(true) });
}
export type EventRegistrar = <T = unknown>(
  eventName: string,
  validate?: PayloadGuard<T>,
) => EventSubscription<T>;

/**
 * Turns an unknown value into text fit to show a user or write to a log.
 *
 * Bare `String()` is wrong for values that arrive across the IPC boundary: on an
 * object it produces the useless "[object Object]", and on a symbol it throws
 * outright. Everything here can reach us from the backend or from a caught
 * `unknown`, so the conversion has to be total.
 */
export function describeUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'symbol') return value.description ?? 'Symbol()';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  try {
    // `JSON.stringify` is typed as returning `string`, but it returns `undefined`
    // for a function or a symbol-valued input. Everything reaching this line
    // has already survived the typeof checks above, so a function is exactly
    // what is left — the fallback is load-bearing, not defensive padding.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see above
    return JSON.stringify(value) ?? Object.prototype.toString.call(value);
  } catch {
    // Cyclic, or a toJSON that throws.
    return Object.prototype.toString.call(value);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isCommandErrorCode(value: unknown): value is CommandErrorCode {
  return COMMAND_ERROR_CODES.includes(value as CommandErrorCode);
}

export function normalizeCommandError(error: unknown): CommandError {
  if (isRecord(error) && isCommandErrorCode(error.code)) {
    return {
      code: error.code,
      message: describeUnknown(error.message ?? error.code),
      details: error.details == null ? undefined : describeUnknown(error.details),
    };
  }
  // Not a `CommandError`: Tauri refused the call before the command ran (bad
  // arguments, a missing permission), or something broke. Its text says what;
  // no code is guessed from it.
  const message = describeUnknown(error) || 'Unknown command error';
  return { code: 'internal', message, details: message };
}

/**
 * Reduces a response that failed, or that arrived in a shape this build does
 * not recognise, to a {@link CommandResult} the caller can report.
 *
 * The transport path already yields a `CommandResult` when `invoke` throws.
 * This covers the other half: a response that resolved but does not match its
 * declared contract, which until now was indistinguishable from a good one
 * because the type was asserted rather than checked.
 */
export function commandFailure(command: string, raw: unknown): CommandResult {
  if (isRecord(raw) && raw.ok === false) {
    const error = normalizeCommandError(raw.error ?? raw.errorCode ?? command);
    return {
      ok: false,
      error: error.message,
      errorCode: isCommandErrorCode(raw.errorCode) ? raw.errorCode : error.code,
      diagnosticDetails: error.details,
    };
  }
  return {
    ok: false,
    error: `${command} returned an unexpected response.`,
    errorCode: 'internal',
    diagnosticDetails: describeUnknown(raw).slice(0, 500),
  };
}

/**
 * Checks a command response against a {@link PayloadGuard}, the way `onEvent`
 * checks an event payload, and substitutes `fallback` when it does not match.
 *
 * Command responses were the unchecked half of the IPC boundary: `invoke<T>`
 * asserts `T` instead of proving it, so between a Rust struct and a TS
 * interface there was nothing but manual synchronisation. Every response routed
 * through here has a shape that has actually been verified, which is what makes
 * the declared type worth trusting downstream — and what makes a defensive
 * check downstream genuinely redundant rather than merely unprovable.
 */
export async function checkedResponse<T, F = T>(
  command: string,
  response: Promise<unknown>,
  guard: PayloadGuard<T>,
  fallback: (raw: unknown) => F,
): Promise<T | F> {
  const raw = await response;
  if (guard(raw)) return raw;
  // A response that already says `ok: false` is a failure the backend reported,
  // not a contract violation — it fails the success guard by definition. Only
  // an unrecognised *successful* shape is worth a console record.
  if (!isRecord(raw) || raw.ok !== false) {
    console.error(`Ignored invalid IPC response shape: ${command}`, raw);
  }
  return fallback(raw);
}

/**
 * The outcome of a command that answers with nothing at all when it worked.
 *
 * A Rust `CommandResult<()>` resolves with `null` on success and rejects on
 * failure, where `invoke` turns the rejection into a failed {@link CommandResult}.
 * This states the success case
 * explicitly, so a caller can check `ok` instead of trusting that a promise
 * which resolved means the write landed.
 */
export async function voidOutcome(
  invoke: InvokeFn,
  command: string,
  args?: InvokeArgs,
): Promise<CommandResult> {
  const raw = await invoke(command, args);
  return hasCommandOutcome(raw) && !raw.ok ? commandFailure(command, raw) : { ok: true };
}

/** Guard for an optional field that must be a string when present. */
export function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/** Guard for an optional field that must be a boolean when present. */
export function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

/** Guard for an optional field that must be a number when present. */
export function optionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

/** Guard for a response that is a bare JSON object with no required fields. */
export function isCommandRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

/** Guard for a response that carries the {@link CommandResult} core. */
export function hasCommandOutcome(
  value: unknown,
): value is CommandResult & Record<string, unknown> {
  return isCommandRecord(value) && typeof value.ok === 'boolean';
}

const nullableString = (value: unknown) => value == null || typeof value === 'string';
const nullableTime = (value: unknown) => nullableString(value) || optionalNumber(value);

/**
 * A listing row from either a local or a remote directory. Checks every field
 * the file list reads: a size that is negative or not finite, or a missing
 * directory flag, would otherwise sort, sum and render as if it were real.
 */
export function isFileEntry(value: unknown): value is FileEntry {
  return (
    isCommandRecord(value) &&
    typeof value.name === 'string' &&
    value.name !== '' &&
    typeof value.isDirectory === 'boolean' &&
    optionalBoolean(value.isHidden) &&
    (value.size === undefined || (optionalNumber(value.size) && (value.size as number) >= 0)) &&
    nullableTime(value.modifiedAt) &&
    nullableTime(value.createdAt) &&
    nullableString(value.permissions) &&
    nullableString(value.owner) &&
    nullableString(value.group) &&
    optionalString(value.path)
  );
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function isTransferProgress(value: unknown): value is TransferProgress {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.connectionId === 'string' &&
    ['progress', 'done', 'error'].includes(String(value.status)) &&
    (value.bytes == null || (typeof value.bytes === 'number' && Number.isFinite(value.bytes))) &&
    (value.total == null || (typeof value.total === 'number' && Number.isFinite(value.total))) &&
    (value.landed == null || (typeof value.landed === 'number' && Number.isFinite(value.landed)))
  );
}

export function isDragOutTransferStarted(value: unknown): value is DragOutTransferStarted {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.connectionId === 'string' &&
    SITE_PROTOCOLS.includes(value.protocol as SiteProtocol) &&
    typeof value.name === 'string' &&
    typeof value.remoteFile === 'string' &&
    (value.isDirectory === undefined || typeof value.isDirectory === 'boolean') &&
    (value.total == null || (typeof value.total === 'number' && Number.isFinite(value.total)))
  );
}

export function isPreviewProgress(value: unknown): value is PreviewProgress {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.connectionId === 'string' &&
    typeof value.bytes === 'number' &&
    Number.isFinite(value.bytes) &&
    typeof value.total === 'number' &&
    Number.isFinite(value.total)
  );
}

export function isUpdaterStatus(value: unknown): value is UpdaterStatus {
  if (!isRecord(value) || typeof value.state !== 'string') return false;
  if (['checking', 'not-available', 'not-packaged'].includes(value.state)) return true;
  if (value.state === 'available' || value.state === 'downloaded')
    return typeof value.version === 'string';
  if (value.state === 'downloading') {
    return (
      typeof value.version === 'string' &&
      (value.percent == null ||
        (typeof value.percent === 'number' &&
          Number.isFinite(value.percent) &&
          value.percent >= 0 &&
          value.percent <= 100))
    );
  }
  return value.state === 'error' && typeof value.message === 'string';
}

export function isVaultLocked(value: unknown): value is VaultLocked {
  return isRecord(value) && VAULT_LOCK_REASONS.includes(value.reason as VaultLockReason);
}

export function isOpenWithChange(value: unknown): value is OpenWithChange {
  return isRecord(value) && typeof value.id === 'string' && typeof value.revision === 'string';
}

export function isRecoveredEditArray(value: unknown): value is RecoveredEdit[] {
  return (
    Array.isArray(value) &&
    value.every(
      (edit) =>
        isRecord(edit) &&
        typeof edit.name === 'string' &&
        (edit.remotePath === null || typeof edit.remotePath === 'string') &&
        typeof edit.savedAt === 'string',
    )
  );
}

function isLogEntry(value: unknown): value is LogEntry {
  return (
    isRecord(value) &&
    typeof value.seq === 'number' &&
    typeof value.kind === 'string' &&
    typeof value.ts === 'number' &&
    typeof value.connectionId === 'string' &&
    (value.server === undefined || typeof value.server === 'string') &&
    (value.line === undefined || typeof value.line === 'string') &&
    (value.key === undefined || typeof value.key === 'string')
  );
}

export function isLogEntryArray(value: unknown): value is LogEntry[] {
  return Array.isArray(value) && value.every(isLogEntry);
}
