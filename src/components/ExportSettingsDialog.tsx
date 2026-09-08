import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalFooterActions } from './Modal.tsx';

export interface ExportSettingsOptions extends Record<string, unknown> {
  includeSettings: boolean;
  includeBookmarks: boolean;
  includeLocalPaths: boolean;
}

interface ExportSettingsDialogProps {
  onExport: (options: ExportSettingsOptions) => unknown;
  onClose: () => void;
  // Which checkbox starts checked, set by SiteManagerDialog's active manager; all three stay editable.
  initialOptions: ExportSettingsOptions;
}

export default function ExportSettingsDialog({
  onExport,
  onClose,
  initialOptions,
}: ExportSettingsDialogProps) {
  const { t } = useTranslation();
  const [includeSettings, setIncludeSettings] = useState(initialOptions.includeSettings);
  const [includeBookmarks, setIncludeBookmarks] = useState(initialOptions.includeBookmarks);
  const [includeLocalPaths, setIncludeLocalPaths] = useState(initialOptions.includeLocalPaths);

  const handleExport = () => {
    onExport({ includeSettings, includeBookmarks, includeLocalPaths });
    onClose();
  };

  return (
    <Modal
      title={t('exportSettingsDialog.title')}
      onClose={onClose}
      className="modal-export-settings"
      footer={
        <ModalFooterActions
          onCancel={onClose}
          onConfirm={handleExport}
          confirmLabel={t('exportSettingsDialog.confirmLabel')}
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
        {t('exportSettingsDialog.includeSettings')}
      </label>
      <label className="secure-toggle settings-toggle">
        <input
          type="checkbox"
          checked={includeBookmarks}
          onChange={(e) => setIncludeBookmarks(e.target.checked)}
        />
        {t('exportSettingsDialog.includeBookmarks')}
      </label>
      <label className="secure-toggle settings-toggle">
        <input
          type="checkbox"
          checked={includeLocalPaths}
          onChange={(e) => setIncludeLocalPaths(e.target.checked)}
        />
        {t('exportSettingsDialog.includeLocalPaths')}
      </label>
      <p className="settings-hint">{t('exportSettingsDialog.passwordHint')}</p>
    </Modal>
  );
}
