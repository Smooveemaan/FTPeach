import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalFooterActions } from '../../../components/Modal.tsx';
import type { SettingsTransferOptions } from '../../../platform/api/settings.ts';

interface SettingsTransferDialogProps {
  mode: 'import' | 'export';
  onConfirm: (options: SettingsTransferOptions) => unknown;
  onClose: () => void;
  /** Which parts start ticked; the Site Manager ticks the manager it belongs to. All stay editable. */
  initialOptions: SettingsTransferOptions;
}

const TEXT = {
  import: {
    title: 'importSettingsDialog.title',
    confirmLabel: 'importSettingsDialog.confirmLabel',
    includeSettings: 'importSettingsDialog.includeSettings',
    includeBookmarks: 'importSettingsDialog.includeBookmarks',
    includeLocalPaths: 'importSettingsDialog.includeLocalPaths',
    passwordHint: 'importSettingsDialog.passwordHint',
  },
  export: {
    title: 'exportSettingsDialog.title',
    confirmLabel: 'exportSettingsDialog.confirmLabel',
    includeSettings: 'exportSettingsDialog.includeSettings',
    includeBookmarks: 'exportSettingsDialog.includeBookmarks',
    includeLocalPaths: 'exportSettingsDialog.includeLocalPaths',
    passwordHint: 'exportSettingsDialog.passwordHint',
  },
} as const;

const PARTS = ['includeSettings', 'includeBookmarks', 'includeLocalPaths'] as const;

/** Chooses what a settings export or import covers; the two differ only in wording. */
export default function SettingsTransferDialog({
  mode,
  onConfirm,
  onClose,
  initialOptions,
}: SettingsTransferDialogProps) {
  const { t } = useTranslation();
  const [options, setOptions] = useState(initialOptions);
  const text = TEXT[mode];

  const confirm = () => {
    onConfirm(options);
    onClose();
  };

  return (
    <Modal
      title={t(text.title)}
      onClose={onClose}
      className="modal-export-settings"
      footer={
        <ModalFooterActions
          onCancel={onClose}
          onConfirm={confirm}
          confirmLabel={t(text.confirmLabel)}
          confirmDisabled={PARTS.every((part) => !options[part])}
        />
      }
    >
      {PARTS.map((part) => (
        <label key={part} className="secure-toggle settings-toggle">
          <input
            type="checkbox"
            checked={options[part]}
            onChange={(e) => setOptions((current) => ({ ...current, [part]: e.target.checked }))}
          />
          {t(text[part])}
        </label>
      ))}
      <p className="settings-hint">{t(text.passwordHint)}</p>
    </Modal>
  );
}
