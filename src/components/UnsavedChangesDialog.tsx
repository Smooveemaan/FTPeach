import { useTranslation } from 'react-i18next';
import Modal from './Modal.tsx';

interface UnsavedChangesDialogProps {
  message: string;
  saveDisabled?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export default function UnsavedChangesDialog({
  message,
  saveDisabled = false,
  onSave,
  onDiscard,
  onCancel,
}: UnsavedChangesDialogProps) {
  const { t } = useTranslation();
  return (
    <Modal
      title={t('settings.unsavedChangesTitle')}
      onClose={onCancel}
      className="modal-confirm"
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn" onClick={onDiscard}>
            {t('settings.discardChanges')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onSave}
            disabled={saveDisabled}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <p>{message}</p>
    </Modal>
  );
}
