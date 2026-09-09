import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../components/Modal.tsx';
import { formatBytes } from '../../shared/format.ts';
import type { OpenWithOpened } from './useOpenWithLifecycle.ts';
import { reportRejection } from '../../shared/asyncFailure.ts';
import { api } from '../../platform/api/index.ts';

interface OpenWithDialogProps {
  remotePath: string;
  connectionId: string;
  size?: number | undefined;
  application: string | null;
  onOpened: (opened: OpenWithOpened) => unknown;
  onClose: () => unknown;
}

interface DownloadProgress {
  bytes: number;
  total?: number;
}

export default function OpenWithDialog({
  remotePath,
  connectionId,
  size,
  application,
  onOpened,
  onClose,
}: OpenWithDialogProps) {
  const { t } = useTranslation();
  const fileName = remotePath.split('/').filter(Boolean).pop() || remotePath;
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let settled = false;
    const id = `openwith-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const unsubscribe = api.openWith.onProgress((p) => {
      if (p.id === id) setProgress({ bytes: p.bytes, total: p.total });
    });
    reportRejection(
      (async () => {
        const res = await api.openWith.start(connectionId, remotePath, id, application);
        settled = true;
        // Set by this effect's cleanup, which the compiler does not model.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (cancelled) {
          // Closed right as the download finished — main already started
          // watching, but nobody will ever consume the events; unwind it. The
          // user has already dismissed the dialog, so a failed unwind has no
          // surface to report to and nothing they could act on.
          if (res.ok) void api.openWith.stop(id);
          return;
        }
        if (!res.ok || !res.localPath) {
          setError(res.error || 'Open-with operation returned no local path.');
          return;
        }
        onOpened({ id, localPath: res.localPath, remotePath });
      })(),
    );
    return () => {
      cancelled = true;
      unsubscribe();
      // The dialog is unmounting because the user dismissed it; a failed
      // cancel has no surface left to report to and nothing they could do.
      if (!settled) void api.transfer.cancel(connectionId, id, 'stop');
    };
    // connectionId omitted because this download started against whichever
    // connectionId was current when it ran, and cancelling/reporting it
    // should stay pinned to that same value, not a since-changed one.
    // onOpened omitted because the caller doesn't wrap it in useCallback —
    // including it would re-run this effect (re-downloading the file) on
    // every render where the parent just happens to pass a new function
    // reference, not only when remotePath actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remotePath]);

  const total = progress?.total || size || 0;
  const percent =
    progress && total > 0 ? Math.min(100, Math.round((progress.bytes / total) * 100)) : null;

  return (
    <Modal
      title={t('openWithDialog.title')}
      onClose={onClose}
      className="modal-open-with"
      footer={
        <button type="button" className="btn" onClick={onClose}>
          {error ? t('common.close') : t('common.cancel')}
        </button>
      }
    >
      {error ? (
        <p className="preview-error openwith-message">{error}</p>
      ) : (
        <div className="openwith-progress">
          <p className="openwith-message">{t('openWithDialog.downloading', { fileName })}</p>
          <div className="openwith-progress-track">
            <div className="openwith-progress-fill" style={{ width: `${percent ?? 0}%` }} />
          </div>
          <span className="openwith-progress-label">
            {percent !== null
              ? t('openWithDialog.progress', {
                  loaded: formatBytes(progress?.bytes),
                  total: formatBytes(total),
                  percent,
                })
              : t('openWithDialog.connecting')}
          </span>
        </div>
      )}
    </Modal>
  );
}
