import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../components/Modal.tsx';
import { api } from '../../platform/api/index.ts';
import type { UpdaterStatus } from '../../platform/ipcContracts.ts';
import type { PaneOrientation, SettingsPatch } from './useSettings.ts';
import { useSettingsDraft } from './hooks/useSettingsDraft.ts';
import type { SaveSettings, SettingsDraftValues } from './hooks/useSettingsDraft.ts';
import { useVaultSettings } from './hooks/useVaultSettings.ts';
import { useProxyPasswordTest } from './hooks/useProxyPasswordTest.ts';
import SettingsNav, { buildSettingsCategories } from './components/SettingsNav.tsx';
import ConnectionSettings from './components/ConnectionSettings.tsx';
import TransfersSettings from './components/TransfersSettings.tsx';
import InterfaceSettings from './components/InterfaceSettings.tsx';
import ShortcutsSettings from './components/ShortcutsSettings.tsx';
import SecuritySettings from './components/SecuritySettings.tsx';
import UpdatesSettings from './components/UpdatesSettings.tsx';
import LoggingSettings from './components/LoggingSettings.tsx';

export interface SettingsDialogProps extends SettingsDraftValues {
  proxyPasswordSet: boolean;
  paneOrientation: PaneOrientation;
  updateStatus: UpdaterStatus | null;
  checkForUpdates: () => unknown;
  onExportDiagnostics: () => Promise<{ ok?: boolean; canceled?: boolean }>;
  narrow: boolean;
  onPreview: (patch: SettingsPatch) => unknown;
  onSave: SaveSettings;
  onClose: () => unknown;
}

export default function SettingsDialog({
  proxyPasswordSet,
  paneOrientation,
  updateStatus,
  checkForUpdates,
  onExportDiagnostics,
  narrow,
  onPreview,
  onSave,
  onClose,
  ...draftValues
}: SettingsDialogProps) {
  const { t } = useTranslation();
  const CATEGORIES = useMemo(() => buildSettingsCategories(t), [t]);
  const [category, setCategory] = useState(CATEGORIES[0].key);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusPanel = () => {
    const panel = panelRef.current;
    if (!panel) return;
    const first = Array.from(
      panel.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]'),
    ).find(
      (element) =>
        element.tabIndex >= 0 &&
        !element.matches(':disabled') &&
        !element.closest('[inert]') &&
        element.getClientRects().length > 0 &&
        getComputedStyle(element).visibility === 'visible',
    );
    (first ?? panel).focus();
  };

  const draft = useSettingsDraft({ ...draftValues, onPreview, onSave, onClose });
  const vault = useVaultSettings();
  const proxyPassword = useProxyPasswordTest({
    proxyTypeValue: draft.proxyTypeValue,
    proxyHostValue: draft.proxyHostValue,
    proxyPortValue: draft.proxyPortValue,
    proxyUsernameValue: draft.proxyUsernameValue,
    markUnsavedChanges: draft.markUnsavedChanges,
  });

  const requestClose = () => draft.requestClose(vault.vaultBusy);
  const handleSave = () => {
    void draft.handleSave(vault.vaultBusy, proxyPassword.buildPasswordPatch());
  };

  return (
    <>
      <Modal
        title={t('settings.title')}
        onClose={draft.discardAndClose}
        onCloseButton={requestClose}
        className={`modal-settings ${narrow ? 'narrow' : ''}`}
      >
        <div className="settings-layout">
          <SettingsNav
            categories={CATEGORIES}
            category={category}
            onSelectCategory={setCategory}
            onEnterPanel={focusPanel}
            narrow={narrow}
            remeasureKey={draft.languageValue}
          />

          {/* A sibling of .settings-nav/.settings-panel (not nested inside the
            nav, as it used to be) — see .settings-layout's grid areas in
            theme.css: this is its own "footer" row/area so only .settings-panel
            scrolls in narrow layouts, instead of the buttons scrolling away
            with the rest of the content. */}
          <div className="settings-nav-footer">
            <button
              type="button"
              className="btn"
              onClick={draft.discardAndClose}
              disabled={vault.vaultBusy || draft.saving}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSave}
              disabled={
                vault.vaultBusy ||
                draft.saving ||
                (draft.proxyEnabledValue && !draft.proxyHostValue.trim())
              }
            >
              {t('common.save')}
            </button>
          </div>

          <div className="settings-panel" ref={panelRef} tabIndex={-1}>
            {draft.saveError && <div role="alert">{draft.saveError}</div>}
            {category === 'connection' && (
              <ConnectionSettings
                timeoutValue={draft.timeoutValue}
                setTimeoutValue={draft.setTimeoutValue}
                saveSessionOnExitValue={draft.saveSessionOnExitValue}
                setSaveSessionOnExitValue={draft.setSaveSessionOnExitValue}
                autoReconnectTabsValue={draft.autoReconnectTabsValue}
                setAutoReconnectTabsValue={draft.setAutoReconnectTabsValue}
                ftpActiveModeValue={draft.ftpActiveModeValue}
                setFtpActiveModeValue={draft.setFtpActiveModeValue}
                proxyEnabledValue={draft.proxyEnabledValue}
                setProxyEnabledValue={draft.setProxyEnabledValue}
                proxyTypeValue={draft.proxyTypeValue}
                setProxyTypeValue={draft.setProxyTypeValue}
                proxyHostValue={draft.proxyHostValue}
                setProxyHostValue={draft.setProxyHostValue}
                proxyPortValue={draft.proxyPortValue}
                setProxyPortValue={draft.setProxyPortValue}
                proxyUsernameValue={draft.proxyUsernameValue}
                setProxyUsernameValue={draft.setProxyUsernameValue}
                proxyPasswordSet={proxyPasswordSet}
                password={proxyPassword}
              />
            )}

            {category === 'transfers' && (
              <TransfersSettings
                concurrencyValue={draft.concurrencyValue}
                setConcurrencyValue={draft.setConcurrencyValue}
                speedLimitValue={draft.speedLimitValue}
                setSpeedLimitValue={draft.setSpeedLimitValue}
                notifyValue={draft.notifyValue}
                setNotifyValue={draft.setNotifyValue}
                overwriteActionValue={draft.overwriteActionValue}
                setOverwriteActionValue={draft.setOverwriteActionValue}
                preventSleepValue={draft.preventSleepValue}
                setPreventSleepValue={draft.setPreventSleepValue}
                openWithAssociationRows={draft.openWithAssociationRows}
                setOpenWithAssociationRows={draft.setOpenWithAssociationRows}
                selectApplication={() => api.fsLocal.selectApplication()}
              />
            )}

            {category === 'interface' && (
              <InterfaceSettings
                themeValue={draft.themeValue}
                setThemeValue={draft.setThemeValue}
                languageValue={draft.languageValue}
                setLanguageValue={draft.setLanguageValue}
                interfaceScaleValue={draft.interfaceScaleValue}
                setInterfaceScaleValue={draft.setInterfaceScaleValue}
                dateFormatValue={draft.dateFormatValue}
                setDateFormatValue={draft.setDateFormatValue}
                defaultLocalPathValue={draft.defaultLocalPathValue}
                setDefaultLocalPathValue={draft.setDefaultLocalPathValue}
                showHiddenFilesValue={draft.showHiddenFilesValue}
                setShowHiddenFilesValue={draft.setShowHiddenFilesValue}
                coloredTabsValue={draft.coloredTabsValue}
                setColoredTabsValue={draft.setColoredTabsValue}
                minimizeToTrayValue={draft.minimizeToTrayValue}
                setMinimizeToTrayValue={draft.setMinimizeToTrayValue}
                closeToTrayValue={draft.closeToTrayValue}
                setCloseToTrayValue={draft.setCloseToTrayValue}
                selectDirectory={() => api.fsLocal.selectDir()}
              />
            )}

            {category === 'shortcuts' && (
              <ShortcutsSettings
                shortcutOverridesValue={draft.shortcutOverridesValue}
                setShortcutOverridesValue={draft.setShortcutOverridesValue}
                paneOrientation={paneOrientation}
              />
            )}

            {category === 'updates' && (
              <UpdatesSettings
                autoCheckUpdatesValue={draft.autoCheckUpdatesValue}
                setAutoCheckUpdatesValue={draft.setAutoCheckUpdatesValue}
                updateStatus={updateStatus}
                checkForUpdates={checkForUpdates}
              />
            )}

            {category === 'logging' && (
              <LoggingSettings
                logEnabledValue={draft.logEnabledValue}
                setLogEnabledValue={draft.setLogEnabledValue}
                logShowTimestampsValue={draft.logShowTimestampsValue}
                setLogShowTimestampsValue={draft.setLogShowTimestampsValue}
                logToFileValue={draft.logToFileValue}
                setLogToFileValue={draft.setLogToFileValue}
                onExportDiagnostics={onExportDiagnostics}
              />
            )}
            {category === 'security' && (
              <SecuritySettings
                vault={vault}
                vaultAutoLockValue={draft.vaultAutoLockValue}
                setVaultAutoLockValue={draft.setVaultAutoLockValue}
                showSecurityConfirmationsValue={draft.showSecurityConfirmationsValue}
                setShowSecurityConfirmationsValue={draft.setShowSecurityConfirmationsValue}
              />
            )}
          </div>
        </div>
      </Modal>

      {draft.confirmCloseArmed && (
        <Modal
          title={t('settings.unsavedChangesTitle')}
          onClose={() => draft.setConfirmCloseArmed(false)}
          className="modal-confirm"
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => draft.setConfirmCloseArmed(false)}
              >
                {t('common.cancel')}
              </button>
              <button type="button" className="btn" onClick={draft.discardAndClose}>
                {t('settings.discardChanges')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  draft.setConfirmCloseArmed(false);
                  handleSave();
                }}
              >
                {t('common.save')}
              </button>
            </>
          }
        >
          <p>{t('settings.unsavedChangesMessage')}</p>
        </Modal>
      )}
    </>
  );
}
