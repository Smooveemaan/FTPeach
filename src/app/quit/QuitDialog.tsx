import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../components/Modal.tsx';

interface QuitDialogProps {
  count: number;
  onQuitNow: () => void;
  onQuitWhenIdle: () => void;
  onCancel: () => void;
}

/** Asks what quitting does to the transfers still running. */
export default function QuitDialog({
  count,
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
          <button type="button" className="btn" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-danger" onClick={onQuitNow}>
            {t('quitDialog.quitNow')}
          </button>
          <button ref={waitRef} type="button" className="btn btn-primary" onClick={onQuitWhenIdle}>
            {t('quitDialog.quitWhenDone')}
          </button>
        </>
      }
    >
      <p>{t('quitDialog.message', { count })}</p>
    </Modal>
  );
}
