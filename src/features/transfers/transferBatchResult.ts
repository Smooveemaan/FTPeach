import i18n from '../../i18n/index.ts';

/** What one item of a copy, move or drop actually did. */
export type TransferItemOutcome = 'copied' | 'moved' | 'skipped' | 'failed';

export interface TransferItemResult {
  name: string;
  outcome: TransferItemOutcome;
  /** The user asked for a move and the source is still where it was. */
  sourceRetained: boolean;
  error?: string;
}

/**
 * The outcome of a whole selection.
 *
 * A batch used to end as `Promise<void>`, so "all ten copied", "three refused"
 * and "the move left the originals behind" were the same answer to the caller:
 * the clipboard was cleared, the panes refreshed and nothing said otherwise.
 */
export interface TransferBatchResult {
  items: TransferItemResult[];
  copied: number;
  moved: number;
  skipped: number;
  failed: number;
  /** Nothing the user asked for was refused. */
  ok: boolean;
  /** At least one move left its source in place. */
  sourceRetained: boolean;
  /** What the user was told about this batch, if anything. */
  message?: string;
}

export const emptyBatch = (): TransferBatchResult => ({
  items: [],
  copied: 0,
  moved: 0,
  skipped: 0,
  failed: 0,
  ok: true,
  sourceRetained: false,
});

/** A batch that never got as far as its items, such as a refused Move. */
export function failedBatch(message: string, moving = false): TransferBatchResult {
  return { ...emptyBatch(), ok: false, sourceRetained: moving, message };
}

/** Counts a batch's items and works out what, if anything, to tell the user. */
export function summarizeBatch(items: TransferItemResult[], moving: boolean): TransferBatchResult {
  const count = (outcome: TransferItemOutcome) =>
    items.filter((item) => item.outcome === outcome).length;
  const failed = count('failed');
  const result: TransferBatchResult = {
    items,
    copied: count('copied'),
    moved: count('moved'),
    skipped: count('skipped'),
    failed,
    ok: failed === 0,
    sourceRetained: items.some((item) => item.sourceRetained),
  };
  const message = describeBatch(result, moving);
  return message === undefined ? result : { ...result, message };
}

/**
 * Skipping is a choice the user already made, so only refusals are reported. A
 * single item speaks through its own error; a selection says how much of it got
 * through, and says separately that the originals of a move are still in place.
 *
 * A transfer that failed inside the queue has already reported itself there and
 * carries no error text here, so it adds no second message of its own.
 */
function describeBatch(result: TransferBatchResult, moving: boolean): string | undefined {
  const firstFailure = result.items.find((item) => item.outcome === 'failed');
  if (!firstFailure) return undefined;
  if (result.items.length === 1) return firstFailure.error;
  const parts = [
    i18n.t('transfers.batchFailed', { failed: result.failed, total: result.items.length }),
  ];
  if (firstFailure.error) parts.push(firstFailure.error);
  if (moving && result.sourceRetained) parts.push(i18n.t('transfers.sourcesKept'));
  return parts.join(' ');
}
