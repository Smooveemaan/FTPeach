import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalFooterActions } from './Modal.tsx';

export interface ImportSettingsOptions extends Record<string, unknown> {
  includeSettings: boolean;
  includeBookmarks: boolean;
  includeLocalPaths: boolean;
}

interface ImportSettingsDialogProps {
  onImport: (options: ImportSettingsOptions) => unknown;
  onClose: () => void;
  // Which checkbox starts checked, set by SiteManagerDialog's active manager; all three stay editable.
  initialOptions: ImportSettingsOptions;
}

export default function ImportSettingsDialog({
  onImport,
  onClose,
  initialOptions,
}: ImportSettingsDialogProps) {
  const { t } = useTranslation();
  const [includeSettings, setIncludeSettings] = useState(initialOptions.includeSettings);
  const [includeBookmarks, setIncludeBookmarks] = useState(initialOptions.includeBookmarks);
  const [includeLocalPaths, setIncludeLocalPaths] = useState(initialOptions.includeLocalPaths);

  const handleImport = () => {
    onImport({ includeSettings, includeBookmarks, includeLocalPaths });
    onClose();
  };

  return (
    <Modal
      title={t('importSettingsDialog.title')}
      onClose={onClose}
      className="modal-export-settings"
      footer={
        <ModalFooterActions
          onCancel={onClose}
          onConfirm={handleImport}
          confirmLabel={t('importSettingsDialog.confirmLabel')}
          confirmDisabled={!includeSettings && !includeBookmarks && !includeLocalPaths}
        />
      }
    >
      <label className="secure-toggle settings-toggle">
        <input
          type="checkbox"
          checked={includeSettings}
          onChange={(e) => setIncludeSettings(e.target.checked)}
        />
        {t('importSettingsDialog.includeSettings')}
      </label>
      <label className="secure-toggle settings-toggle">
        <input
          type="checkbox"
          checked={includeBookmarks}
          onChange={(e) => setIncludeBookmarks(e.target.checked)}
        />
        {t('importSettingsDialog.includeBookmarks')}
      </label>
      <label className="secure-toggle settings-toggle">
        <input
          type="checkbox"
          checked={includeLocalPaths}
          onChange={(e) => setIncludeLocalPaths(e.target.checked)}
        />
        {t('importSettingsDialog.includeLocalPaths')}
      </label>
      <p className="settings-hint">{t('importSettingsDialog.passwordHint')}</p>
    </Modal>
  );
}
