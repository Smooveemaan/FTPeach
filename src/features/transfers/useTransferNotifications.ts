import { useEffect, useEffectEvent, useRef } from 'react';
import { api } from '../../platform/api/index.ts';
import { reportAsyncFailure } from '../../shared/asyncFailure.ts';
import type { Translate } from '../../shared/translate.ts';
import type { TransferRow, TransferStatus } from './transferStore.ts';
import {
  getTransfersSnapshot,
  hasOpenTransferBatches,
  subscribeTransferStructure,
} from './transferStore.ts';

/** How long results collect before their notification is sent. */
export const NOTIFY_SETTLE_MS = 1500;

interface Tally {
  succeeded: number;
  failed: number;
}

// A folder is one row but reports every file it delivered; an empty or
// skipped folder delivered none. Its error describes the operation, not a file count.
const tally = (row: TransferRow): Tally => ({
  succeeded: row.files ?? (row.status === 'done' ? 1 : 0),
  failed: row.status === 'error' ? 1 : 0,
});

export function useTransferNotifications(t: Translate): void {
  const notifiedRef = useRef(new Map<string, TransferStatus>());
  const wasActiveRef = useRef(false);
  // Individual results exist only while their rows do. Retention folds evicted
  // rows into aggregate counters, so a continuous queue cannot grow these maps.
  const pendingRef = useRef(new Map<string, Tally>());
  const evictedRef = useRef<Tally>({ succeeded: 0, failed: 0 });
  const announcedErrorsRef = useRef(new Map<string, number>());
  const announcedEvictedErrorsRef = useRef(0);
  const finalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const deliver = useEffectEvent((succeeded: number, failed: number, earlierError = false) => {
    const title =
      failed || earlierError ? t('transfers.notifyErrorTitle') : t('transfers.notifyCompleteTitle');
    const succeededText = succeeded ? t('transfers.notifySucceeded', { count: succeeded }) : '';
    const failedText = failed ? t('transfers.notifyFailed') : '';
    const body =
      succeededText && failedText
        ? t('transfers.notifyBoth', { succeeded: succeededText, failed: failedText })
        : succeededText || failedText;
    void api.notifications
      .transfersComplete({ succeeded, failed, title, body })
      .then((result) => {
        if (result.ok) return;
        if (result.errorCode !== 'internal' && result.errorCode !== 'invalidInput')
          console.warn('Transfer notification failed', result.error);
        reportAsyncFailure(t('transfers.notifyDeliveryFailed'), 'transfer-notification');
      })
      .catch((error: unknown) => {
        console.warn('Transfer notification failed', error);
        reportAsyncFailure(t('transfers.notifyDeliveryFailed'), 'transfer-notification');
      });
  });

  const announceErrors = useEffectEvent(() => {
    errorTimerRef.current = null;
    let failed = evictedRef.current.failed;
    announcedEvictedErrorsRef.current += evictedRef.current.failed;
    evictedRef.current.failed = 0;
    for (const [id, result] of pendingRef.current) {
      if (!result.failed) continue;
      failed += result.failed;
      announcedErrorsRef.current.set(id, result.failed);
      pendingRef.current.set(id, { succeeded: result.succeeded, failed: 0 });
    }
    if (failed) deliver(0, failed);
  });

  const announceFinal = useEffectEvent(() => {
    finalTimerRef.current = null;
    let succeeded = evictedRef.current.succeeded;
    let failed = evictedRef.current.failed;
    for (const result of pendingRef.current.values()) {
      succeeded += result.succeeded;
      failed += result.failed;
    }
    const earlierError =
      announcedEvictedErrorsRef.current > 0 || announcedErrorsRef.current.size > 0;
    pendingRef.current.clear();
    evictedRef.current = { succeeded: 0, failed: 0 };
    announcedErrorsRef.current.clear();
    announcedEvictedErrorsRef.current = 0;
    if (succeeded + failed) deliver(succeeded, failed, earlierError);
  });

  useEffect(() => {
    const stopListening = subscribeTransferStructure(() => {
      const values = Object.values(getTransfersSnapshot());
      const retained = new Set(values.map((row) => row.id));
      for (const id of notifiedRef.current.keys()) {
        if (retained.has(id)) continue;
        notifiedRef.current.delete(id);
        const result = pendingRef.current.get(id);
        if (result) {
          evictedRef.current.succeeded += result.succeeded;
          evictedRef.current.failed += result.failed;
          pendingRef.current.delete(id);
        }
        const announced = announcedErrorsRef.current.get(id);
        if (announced) {
          announcedEvictedErrorsRef.current += announced;
          announcedErrorsRef.current.delete(id);
        }
      }
      for (const item of values) {
        const finished = item.status === 'done' || item.status === 'error';
        if (!finished) {
          notifiedRef.current.delete(item.id);
          pendingRef.current.delete(item.id);
          announcedErrorsRef.current.delete(item.id);
        }
        if (!finished || notifiedRef.current.get(item.id) === item.status) continue;
        notifiedRef.current.set(item.id, item.status);
        // Results seen in the window must not surface after it loses focus during settling.
        if (!document.hasFocus()) pendingRef.current.set(item.id, tally(item));
      }
      const active =
        hasOpenTransferBatches() ||
        values.some((item) => ['progress', 'queued', 'cancelling', 'paused'].includes(item.status));
      const hasPendingErrors =
        evictedRef.current.failed > 0 ||
        [...pendingRef.current.values()].some((result) => result.failed > 0);
      if (hasPendingErrors && !errorTimerRef.current)
        errorTimerRef.current = setTimeout(announceErrors, NOTIFY_SETTLE_MS);
      if (active && finalTimerRef.current) {
        clearTimeout(finalTimerRef.current);
        finalTimerRef.current = null;
      } else if (wasActiveRef.current && !active) {
        finalTimerRef.current = setTimeout(announceFinal, NOTIFY_SETTLE_MS);
      }
      wasActiveRef.current = active;
    });
    return () => {
      stopListening();
      if (finalTimerRef.current) clearTimeout(finalTimerRef.current);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, []);
}
