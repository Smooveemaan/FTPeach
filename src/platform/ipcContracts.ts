import type { LogEntry, SiteProtocol } from '../shared/types.ts';

const SITE_PROTOCOLS: readonly SiteProtocol[] = ['ftp', 'ftps', 'sftp', 'webdav'];

export type CommandErrorCode =
  | 'authFailed'
  | 'connectionRefused'
  | 'timedOut'
  | 'hostKeyMismatch'
  | 'invalidCertificate'
  | 'tlsNegotiationFailed'
  | 'sshNegotiationFailed'
  | 'proxyFailed'
  | 'notFound'
  | 'permissionDenied'
  | 'cancelled'
  | 'integrityMismatch'
  | 'networkUnreachable'
  | 'connectionLost'
  | 'invalidInput'
  | 'resourceLimit'
  | 'busy'
  | 'vaultLocked'
  | 'internal';

export interface CommandError {
  code: CommandErrorCode;
  message: string;
  details?: string | undefined;
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
export interface OpenWithChange {
  id: string;
  [key: string]: unknown;
}

export type InvokeArgs = Record<string, unknown>;
export type InvokeResult<T = unknown> = T | CommandResult;
export type InvokeFn = <T = unknown>(
  command: string,
  args?: InvokeArgs,
) => Promise<InvokeResult<T>>;
export type PayloadGuard<T> = (value: unknown) => value is T;
export type EventSubscription<T> = (callback: (payload: T) => void) => () => void;
export type EventRegistrar = <T = unknown>(
  eventName: string,
  validate?: PayloadGuard<T>,
) => EventSubscription<T>;

const ERROR_PATTERNS: ReadonlyArray<readonly [CommandErrorCode, RegExp]> = [
  ['hostKeyMismatch', /HOST_KEY_MISMATCH|host key mismatch/i],
  [
    'authFailed',
    /(?:^|\s)530[ -]|login incorrect|auth fail|authentication methods failed|\b401\b/i,
  ],
  ['connectionRefused', /os error 10061|connection refused/i],
  ['timedOut', /os error 10060|timed out/i],
  ['invalidCertificate', /certificate|CERT_|SELF_SIGNED/i],
  ['tlsNegotiationFailed', /TLS (?:handshake|negotiation) failed/i],
  ['sshNegotiationFailed', /SSH (?:handshake|negotiation) failed|no common .*algorithm/i],
  ['proxyFailed', /proxy (?:handshake failed|rejected)|could not connect to proxy/i],
  ['permissionDenied', /permission denied|no permission|os error 5\b|\b403\b/i],
  ['notFound', /not found|os error [23]\b/i],
  ['cancelled', /cancell?ed by user/i],
  ['integrityMismatch', /integrity|checksum|hash mismatch/i],
  ['networkUnreachable', /os error 100(?:50|51|65)/i],
  ['connectionLost', /os error 100(?:52|53|54)/i],
  ['vaultLocked', /vault is locked/i],
];

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
  return (
    typeof value === 'string' &&
    (ERROR_PATTERNS.some(([code]) => code === value) ||
      ['invalidInput', 'resourceLimit', 'busy', 'internal'].includes(value))
  );
}

export function inferErrorCode(message: unknown): CommandErrorCode {
  const text = typeof message === 'string' ? message : '';
  return ERROR_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'internal';
}

export function normalizeCommandError(error: unknown): CommandError {
  if (isRecord(error) && isCommandErrorCode(error.code)) {
    return {
      code: error.code,
      message: describeUnknown(error.message ?? error.code),
      details: error.details == null ? undefined : describeUnknown(error.details),
    };
  }
  const message = describeUnknown(error) || 'Unknown command error';
  return { code: inferErrorCode(message), message, details: message };
}

/**
 * Converts a failed legacy invoke response into a typed {@link CommandResult}.
 *
 * Error details are normalized through {@link normalizeCommandError}.
 */
export function normalizeInvokeResponse<T>(value: T): T | CommandResult {
  if (!isRecord(value) || value.ok !== false || !value.error) return value;
  const error = normalizeCommandError(value.error);
  return {
    ...value,
    ok: false,
    error: error.message,
    errorCode: isCommandErrorCode(value.errorCode) ? value.errorCode : error.code,
    diagnosticDetails: error.details,
  };
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
 * The common case of {@link checkedResponse}: a command whose whole response is
 * a plain {@link CommandResult}. Declaring one through `invoke<CommandResult>`
 * only asserted the shape; this proves it.
 */
export function commandOutcome(
  invoke: InvokeFn,
  command: string,
  args?: InvokeArgs,
): Promise<CommandResult> {
  return checkedResponse(command, invoke(command, args), hasCommandOutcome, (raw) =>
    commandFailure(command, raw),
  );
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

export function isOpenWithChange(value: unknown): value is OpenWithChange {
  return isRecord(value) && typeof value.id === 'string';
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
