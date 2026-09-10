import { canPauseTransfer, type TransferRow, type TransferStatus } from './transferStore.ts';
import type { IconName } from '../../components/Icon.tsx';

/**
 * Which way a row's bytes actually travel, read from its endpoints. The row's
 * `direction` says how the transfer is run instead, which is not the same
 * thing: a folder is a 'recursive' walk whichever way it goes, including
 * between two folders on this computer, and a relay 'copy' can have the same
 * session at both ends.
 */
export type TransferRoute = 'up' | 'down' | 'copy' | 'local-copy' | 'server-copy';

export function transferRoute(row: TransferRow): TransferRoute {
  if (row.direction === 'copy') {
    return row.sourceConnectionId === row.targetConnectionId ? 'server-copy' : 'copy';
  }
  if (row.direction !== 'recursive') return row.direction;
  const { source, target } = row.intent;
  if (source.kind === 'local') return target.kind === 'local' ? 'local-copy' : 'up';
  if (target.kind === 'local') return 'down';
  return source.connectionId === target.connectionId ? 'server-copy' : 'copy';
}

/**
 * Why a row's Pause is greyed out, named for what the row really is, or null
 * when it can pause: a relay copy has no resumable stream, a folder moved
 * within one server is a single rename, and what is left writes to WebDAV.
 */
export function pauseUnsupportedKey(row: TransferRow): string | null {
  if (canPauseTransfer(row)) return null;
  const route = transferRoute(row);
  const relayOrMove =
    row.direction === 'copy' || (row.direction === 'recursive' && row.intent.moving);
  if (relayOrMove && route === 'server-copy') return 'transferQueue.pauseUnsupportedServerCopy';
  if (relayOrMove && route === 'copy') return 'transferQueue.pauseUnsupportedCopy';
  return 'transferQueue.pauseUnsupportedWebdav';
}

export const STATUS_LABEL_KEY: Record<Exclude<TransferStatus, 'progress'>, string> = {
  queued: 'transferQueue.status.queued',
  cancelling: 'transferQueue.status.cancelling',
  done: 'transferQueue.status.done',
  error: 'transferQueue.status.error',
  paused: 'transferQueue.status.paused',
  stopped: 'transferQueue.status.stopped',
};
export const PROGRESS_LABEL_KEY: Record<TransferRoute, string> = {
  up: 'transferQueue.direction.up',
  down: 'transferQueue.direction.down',
  copy: 'transferQueue.direction.copy',
  'local-copy': 'transferQueue.direction.copy',
  'server-copy': 'transferQueue.direction.copy',
};
export const DIR_ICON: Record<TransferRoute, IconName> = {
  up: 'arrowUp',
  down: 'arrowDown',
  copy: 'arrowLeftRight',
  'local-copy': 'arrowLeftRight',
  'server-copy': 'arrowLeftRight',
};
export const DIR_TITLE_KEY: Record<TransferRoute, string> = {
  up: 'transferQueue.direction.up',
  down: 'transferQueue.direction.down',
  copy: 'transferQueue.directionTitleCopy',
  'local-copy': 'transferQueue.directionTitleLocal',
  'server-copy': 'transferQueue.directionTitleServer',
};

/** Every string a row's `.status-tag` pill can actually show — the four
 * terminal statuses plus the three in-progress directions (transferQueue's
 * status column shows the active direction, not a generic "in progress"). */
export const STATUS_TAG_KEYS: readonly string[] = [
  ...Object.values(STATUS_LABEL_KEY),
  ...Object.values(PROGRESS_LABEL_KEY),
];
