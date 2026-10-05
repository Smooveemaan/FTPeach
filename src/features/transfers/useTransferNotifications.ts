import { useEffect, useEffectEvent, useRef } from 'react';
import { api } from '../../platform/api/index.ts';
import type { Translate } from '../../shared/translate.ts';
import type { TransferRow, TransferStatus } from './transferStore.ts';
import {
  getTransfersSnapshot,
  hasOpenTransferBatches,
  subscribeTransferStructure,
} from './transferStore.ts';

/** How long the queue must stay idle before its end is announced. */
export const NOTIFY_SETTLE_MS = 1500;

interface Tally {
  succeeded: number;
  failed: number;
}

// A folder is one row but reports every file it delivered; an empty or
// skipped folder delivered none.
// ponytail: a folder that failed counts as one failure, not its failed files;
// count them once the walk reports how many failed.
const tally = (row: TransferRow): Tally => ({
  succeeded: row.files ?? (row.status === 'done' ? 1 : 0),
  failed: row.status === 'error' ? 1 : 0,
});

export function useTransferNotifications(t: Translate): void {
  const notifiedRef = useRef(new Map<string, TransferStatus>());
  const wasActiveRef = useRef(false);
  // Counted as rows finish, not at the end: the store keeps only the newest
  // finished rows, so a long run would be reported short. Keyed by row, so a
  // failure that a retry then fixed counts only as the success.
  const pendingRef = useRef(new Map<string, Tally>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announce = useEffectEvent(() => {
    timerRef.current = null;
    let succeeded = 0;
    let failed = 0;
    for (const row of pendingRef.current.values()) {
      succeeded += row.succeeded;
      failed += row.failed;
    }
    pendingRef.current.clear();
    if (!(succeeded + failed)) return;
    const title = failed ? t('transfers.notifyErrorTitle') : t('transfers.notifyCompleteTitle');
    const succeededText = succeeded ? t('transfers.notifySucceeded', { count: succeeded }) : '';
    const failedText = failed ? t('transfers.notifyFailed', { count: failed }) : '';
    // The two halves are joined through a translated pattern, not a
    // comma in code: CJK separates clauses with 、 and Arabic with ، .
    const body =
      succeededText && failedText
        ? t('transfers.notifyBoth', { succeeded: succeededText, failed: failedText })
        : succeededText || failedText;
    void api.notifications.transfersComplete({ succeeded, failed, title, body });
  });
  useEffect(() => {
    const stopListening = subscribeTransferStructure(() => {
      const values = Object.values(getTransfersSnapshot());
      const retained = new Set(values.map((row) => row.id));
      for (const id of notifiedRef.current.keys())
        if (!retained.has(id)) notifiedRef.current.delete(id);
      for (const item of values) {
        const finished = item.status === 'done' || item.status === 'error';
        // A retried row that finishes again counts again.
        if (!finished) notifiedRef.current.delete(item.id);
        if (!finished || notifiedRef.current.get(item.id) === item.status) continue;
        notifiedRef.current.set(item.id, item.status);
        pendingRef.current.set(item.id, tally(item));
      }
      // A pause is not an ending, and neither is the gap between two parts
      // of a selection still being admitted. An error is not held back for a
      // pause, though: the user may not come back to it for a long time.
      const failed = [...pendingRef.current.values()].some((row) => row.failed);
      const active =
        hasOpenTransferBatches() ||
        values.some(
          (item) =>
            ['progress', 'queued', 'cancelling'].includes(item.status) ||
            (item.status === 'paused' && !failed),
        );
      // Downloads dragged out to Explorer run one after another, and the
      // queue is empty for a moment between them: only a quiet spell ends it.
      if (active && timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      } else if (wasActiveRef.current && !active) {
        timerRef.current = setTimeout(announce, NOTIFY_SETTLE_MS);
      }
      wasActiveRef.current = active;
    });
    return () => {
      stopListening();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);
}
