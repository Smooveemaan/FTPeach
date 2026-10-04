import { useEffect, useRef } from 'react';
import { api } from '../../platform/api/index.ts';
import { reportRejection } from '../../shared/asyncFailure.ts';
import type { Translate } from '../../shared/translate.ts';
import type { TransferStatus } from './transferStore.ts';
import {
  getTransfersSnapshot,
  hasOpenTransferBatches,
  subscribeTransferStructure,
} from './transferStore.ts';

/** How long the queue must stay idle before its end is announced. */
export const NOTIFY_SETTLE_MS = 1500;

export function useTransferNotifications(t: Translate): void {
  const notifiedRef = useRef(new Map<string, TransferStatus>());
  const wasActiveRef = useRef(false);
  // Counted as rows finish, not at the end: the store keeps only the newest
  // finished rows, so a long run would be reported short.
  const pendingRef = useRef({ succeeded: 0, failed: 0 });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const announce = () => {
      timerRef.current = null;
      const { succeeded, failed } = pendingRef.current;
      pendingRef.current = { succeeded: 0, failed: 0 };
      if (!(succeeded + failed)) return;
      const title =
        failed && !succeeded ? t('transfers.notifyErrorTitle') : t('transfers.notifyCompleteTitle');
      const succeededText = succeeded ? t('transfers.notifySucceeded', { count: succeeded }) : '';
      const failedText = failed ? t('transfers.notifyFailed', { count: failed }) : '';
      // The two halves are joined through a translated pattern, not a
      // comma in code: CJK separates clauses with 、 and Arabic with ، .
      const body =
        succeededText && failedText
          ? t('transfers.notifyBoth', { succeeded: succeededText, failed: failedText })
          : succeededText || failedText;
      reportRejection(api.notifications.transfersComplete({ succeeded, failed, title, body }));
    };
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
        if (item.status === 'done') pendingRef.current.succeeded += 1;
        else pendingRef.current.failed += 1;
      }
      // A pause is not an ending, and neither is the gap between two parts
      // of a selection still being admitted.
      const active =
        hasOpenTransferBatches() ||
        values.some((item) =>
          (['progress', 'queued', 'cancelling', 'paused'] as TransferStatus[]).includes(
            item.status,
          ),
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
  }, [t]);
}
