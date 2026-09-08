import { reportAsyncFailure } from '../shared/asyncFailure.ts';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalFooterActions } from './Modal.tsx';
import type { ReactNode } from 'react';

interface ConfirmDialogProps {
  title?: ReactNode;
  message: ReactNode;
  confirmLabel?: ReactNode | undefined;
  danger?: boolean | undefined;
  onConfirm: () => unknown;
  onClose: () => void;
  onCancel?: (() => unknown) | undefined;
}

export default function ConfirmDialog({
  title = 'FTPeach',
  message,
  confirmLabel,
  danger = true,
  onConfirm,
  onClose,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const handleCancel = () => {
    onCancel?.();
    onClose();
  };
  const handleConfirm = () => {
    onClose();
    Promise.resolve(onConfirm()).catch(reportAsyncFailure);
  };

  return (
    <Modal
      title={title}
      onClose={handleCancel}
      className="modal-confirm"
      initialFocusRef={confirmRef}
      footer={
        <ModalFooterActions
          onCancel={handleCancel}
          onConfirm={handleConfirm}
          confirmLabel={confirmLabel ?? t('paneMenu.delete')}
          danger={danger}
          confirmRef={confirmRef}
        />
      }
    >
      <p>{message}</p>
    </Modal>
  );
}
