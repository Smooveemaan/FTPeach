import type { TransferDirection, TransferStatus } from './transferStore.ts';
import type { IconName } from '../../components/Icon.tsx';
export const STATUS_LABEL_KEY: Record<Exclude<TransferStatus, 'progress'>, string> = {
  queued: 'transferQueue.status.queued',
  cancelling: 'transferQueue.status.cancelling',
  done: 'transferQueue.status.done',
  error: 'transferQueue.status.error',
  paused: 'transferQueue.status.paused',
  stopped: 'transferQueue.status.stopped',
};
export const PROGRESS_LABEL_KEY: Record<TransferDirection, string> = {
  up: 'transferQueue.direction.up',
  down: 'transferQueue.direction.down',
  copy: 'transferQueue.direction.copy',
  recursive: 'transferQueue.direction.copy',
};
export const DIR_ICON: Record<TransferDirection, IconName> = {
  up: 'arrowUp',
  down: 'arrowDown',
  copy: 'arrowLeftRight',
  recursive: 'folder',
};
export const DIR_TITLE_KEY: Record<TransferDirection, string> = {
  up: 'transferQueue.direction.up',
  down: 'transferQueue.direction.down',
  copy: 'transferQueue.directionTitleCopy',
  recursive: 'transferQueue.directionTitleCopy',
};

/** Every string a row's `.status-tag` pill can actually show — the four
 * terminal statuses plus the three in-progress directions (transferQueue's
 * status column shows the active direction, not a generic "in progress"). */
export const STATUS_TAG_KEYS: readonly string[] = [
  ...Object.values(STATUS_LABEL_KEY),
  ...Object.values(PROGRESS_LABEL_KEY),
];
