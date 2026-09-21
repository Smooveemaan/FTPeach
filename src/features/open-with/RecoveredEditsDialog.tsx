import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalFooterActions } from '../../components/Modal.tsx';
import type { RecoveredEdit } from '../../platform/ipcContracts.ts';

interface RecoveredEditsDialogProps {
  edits: RecoveredEdit[];
  onReveal: () => unknown;
  onDiscard: () => unknown;
  onLater: () => unknown;
}

/** Offers the edits an earlier run kept because they never reached the server. */
export default function RecoveredEditsDialog({
  edits,
  onReveal,
  onDiscard,
  onLater,
}: RecoveredEditsDialogProps) {
  const { t } = useTranslation();
  // Deleting is the one answer that loses the user's work, so it takes a
  // second, explicit step.
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  return (
    <Modal
      title={t('recoveredEdits.title')}
      onClose={() => onLater()}
      className="modal-confirm"
      footer={
        confirmingDiscard ? (
          <ModalFooterActions
            onCancel={() => setConfirmingDiscard(false)}
            onConfirm={() => onDiscard()}
            confirmLabel={t('recoveredEdits.discard')}
            danger
          />
        ) : (
          <>
            <button type="button" className="btn" onClick={() => setConfirmingDiscard(true)}>
              {t('recoveredEdits.discard')}
            </button>
            <button type="button" className="btn" onClick={() => onLater()}>
              {t('recoveredEdits.later')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => onReveal()}>
              {t('recoveredEdits.show')}
            </button>
          </>
        )
      }
    >
      <p>{confirmingDiscard ? t('recoveredEdits.confirmDiscard') : t('recoveredEdits.message')}</p>
      <ul className="recovered-edits">
        {edits.map((edit) => (
          <li key={`${edit.savedAt}:${edit.name}`}>
            <strong>{edit.name}</strong>
            <span>{edit.remotePath ?? t('recoveredEdits.unknownPath')}</span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
