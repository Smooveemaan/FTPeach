import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalFooterActions } from './Modal.tsx';
import type { ReactNode } from 'react';

interface PromptDialogProps {
  title: ReactNode;
  label: ReactNode;
  defaultValue?: string;
  confirmLabel?: ReactNode;
  onSubmit: (value: string) => unknown;
  onClose: () => void;
}

// Electron's renderer does not implement window.prompt() (it throws), so
// text-input prompts need their own dialog instead of the browser built-in.
export default function PromptDialog({
  title,
  label,
  defaultValue = '',
  confirmLabel,
  onSubmit,
  onClose,
}: PromptDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(defaultValue);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    onClose();
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      className="modal-prompt"
      footer={
        <ModalFooterActions
          onCancel={onClose}
          onConfirm={handleSubmit}
          confirmLabel={confirmLabel ?? t('promptDialog.confirmLabel')}
        />
      }
    >
      <label className="settings-field">
        <span>{label}</span>
        <input
          type="text"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmit();
          }}
        />
      </label>
    </Modal>
  );
}
