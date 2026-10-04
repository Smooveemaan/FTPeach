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
  /** An error to show under the field instead of submitting, or null. */
  validate?: (value: string) => string | null;
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
  validate,
}: PromptDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const invalid = validate?.(trimmed) ?? null;
    setError(invalid);
    if (invalid) return;
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
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmit();
          }}
        />
      </label>
      {error && (
        <p className="settings-hint settings-warning" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
