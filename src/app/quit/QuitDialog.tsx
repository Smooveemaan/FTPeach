import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../components/Modal.tsx';

interface QuitDialogProps {
  count: number;
  unsyncedEdits?: number;
  onQuitNow: () => void;
  onQuitWhenIdle: () => void;
  onCancel: () => void;
}

/** Asks what quitting does to the transfers still running. */
export default function QuitDialog({
  count,
  unsyncedEdits = 0,
  onQuitNow,
  onQuitWhenIdle,
  onCancel,
}: QuitDialogProps) {
  const { t } = useTranslation();
  // Focus starts on the choice that loses nothing.
  const waitRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      title="FTPeach"
      onClose={onCancel}
      className="modal-confirm"
      initialFocusRef={waitRef}
      footer={
        <>
          <button
            ref={unsyncedEdits > 0 ? waitRef : undefined}
            type="button"
            className="btn"
            onClick={onCancel}
          >
            {t(unsyncedEdits > 0 ? 'quitDialog.return' : 'common.cancel')}
          </button>
          <button type="button" className="btn btn-danger" onClick={onQuitNow}>
            {t(unsyncedEdits > 0 ? 'quitDialog.preserveAndQuit' : 'quitDialog.quitNow')}
          </button>
          {count > 0 && (
            <button
              ref={unsyncedEdits > 0 ? undefined : waitRef}
              type="button"
              className="btn btn-primary"
              onClick={onQuitWhenIdle}
            >
              {t('quitDialog.quitWhenDone')}
            </button>
          )}
        </>
      }
    >
      {count > 0 && <p>{t('quitDialog.message', { count })}</p>}
      {unsyncedEdits > 0 && <p>{t('quitDialog.unsyncedEdits', { count: unsyncedEdits })}</p>}
    </Modal>
  );
}
