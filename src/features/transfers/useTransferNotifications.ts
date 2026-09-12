import { useEffect, useRef } from 'react';
import { api } from '../../platform/api/index.ts';
import { reportRejection } from '../../shared/asyncFailure.ts';
import type { Translate } from '../../shared/types.ts';
import type { TransferStatus } from './transferStore.ts';
import { getTransfersSnapshot, subscribeTransfers } from './transferStore.ts';

export function useTransferNotifications(t: Translate): void {
  const notifiedRef = useRef(new Map<string, TransferStatus>());
  const wasActiveRef = useRef(false);
  useEffect(
    () =>
      subscribeTransfers(() => {
        const values = Object.values(getTransfersSnapshot());
        const active = values.some(
          (item) => item.status === 'progress' || item.status === 'queued',
        );
        if (wasActiveRef.current && !active) {
          let succeeded = 0;
          let failed = 0;
          for (const item of values) {
            if (
              !(['done', 'error'] as TransferStatus[]).includes(item.status) ||
              notifiedRef.current.get(item.id) === item.status
            )
              continue;
            notifiedRef.current.set(item.id, item.status);
            if (item.status === 'done') succeeded += 1;
            else failed += 1;
          }
          if (succeeded + failed) {
            const title =
              failed && !succeeded
                ? t('transfers.notifyErrorTitle')
                : t('transfers.notifyCompleteTitle');
            const succeededText = succeeded
              ? t('transfers.notifySucceeded', { count: succeeded })
              : '';
            const failedText = failed ? t('transfers.notifyFailed', { count: failed }) : '';
            // The two halves are joined through a translated pattern, not a
            // comma in code: CJK separates clauses with 、 and Arabic with ، .
            const body =
              succeededText && failedText
                ? t('transfers.notifyBoth', { succeeded: succeededText, failed: failedText })
                : succeededText || failedText;
            reportRejection(
              api.notifications.transfersComplete({
                succeeded,
                failed,
                title,
                body,
              }),
            );
          }
        }
        wasActiveRef.current = active;
      }),
    [t],
  );
}
