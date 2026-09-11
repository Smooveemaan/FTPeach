import { canPauseTransfer, type TransferRow, type TransferStatus } from './transferStore.ts';
import type { IconName } from '../../components/Icon.tsx';
import type { RecursiveEndpoint } from '../../platform/api/transfers.ts';
import type { Translate } from '../../shared/types.ts';
import { isolate } from '../../shared/bidi.ts';

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
 * Where a row's bytes come from and where they land. A drag-out's target is
 * null: Explorer picks a folder on this computer and never says which.
 */
export function transferEndpoints(row: TransferRow): {
  source: RecursiveEndpoint;
  target: RecursiveEndpoint | null;
} {
  switch (row.direction) {
    case 'recursive':
      return row.intent;
    case 'up':
      return {
        source: { kind: 'local', path: row.localFile },
        target: { kind: 'remote', path: row.remoteTarget, connectionId: row.connectionId },
      };
    case 'down':
      return {
        source: { kind: 'remote', path: row.remoteFile, connectionId: row.connectionId },
        target: row.dragOut ? null : { kind: 'local', path: row.localTarget },
      };
    case 'copy':
      return {
        source: { kind: 'remote', path: row.sourcePath, connectionId: row.sourceConnectionId },
        target: { kind: 'remote', path: row.remoteTarget, connectionId: row.targetConnectionId },
      };
  }
}

function routeParent(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (index < 0) return path;
  return trimmed.slice(0, index === 0 || (index === 2 && trimmed[1] === ':') ? index + 1 : index);
}

function routeFolder(path: string): string {
  const parent = routeParent(path);
  return (
    parent
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop()
      ?.replace(/^([A-Za-z]):$/, '$1:\\') || parent
  );
}

/** Both endpoints stay visible; full paths are reserved for the tooltip. */
export function transferRoutePlaces(
  row: TransferRow,
  labelOf: (connectionId: string) => string,
  t: Translate,
): [string, string] {
  const { source, target } = transferEndpoints(row);
  const sameServer =
    source.kind === 'remote' &&
    target?.kind === 'remote' &&
    source.connectionId === target.connectionId;
  const place = (end: RecursiveEndpoint | null) => {
    if (!end) return t('tabStrip.localComputer');
    if (end.kind === 'local') return routeFolder(end.path);
    return sameServer
      ? `${labelOf(end.connectionId)}: ${routeFolder(end.path)}`
      : labelOf(end.connectionId);
  };
  return [place(source), place(target)];
}

/** The same route in full, down to the path at either end. */
export function transferRouteTooltip(
  row: TransferRow,
  labelOf: (connectionId: string) => string,
  t: Translate,
): string {
  const { source, target } = transferEndpoints(row);
  const describe = (end: RecursiveEndpoint) =>
    end.kind === 'local' ? end.path : `${labelOf(end.connectionId)}: ${end.path}`;
  return target === null
    ? describe(source)
    : t('transferQueue.route', { from: isolate(describe(source)), to: isolate(describe(target)) });
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
  copy: 'copy',
  'local-copy': 'copy',
  'server-copy': 'copy',
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

export function transferFilePath(item: TransferRow): string {
  return item.direction === 'recursive'
    ? item.intent.source.path
    : item.direction === 'up'
      ? item.localFile
      : item.direction === 'down'
        ? item.remoteFile
        : item.sourcePath;
}

export function transferDisplayName(item: TransferRow): string {
  const isDirectory = item.direction === 'recursive' || (item.dragOut && item.isDirectory);
  const fullPath = transferFilePath(item);
  return isDirectory
    ? fullPath
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop() || fullPath
    : item.name;
}
