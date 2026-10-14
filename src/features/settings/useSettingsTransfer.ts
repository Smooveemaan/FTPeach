import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../platform/api/index.ts';
import type {
  AppSettings,
  ExportSecrets,
  ImportSettingsResult,
  SettingsTransferOptions,
} from '../../platform/api/settings.ts';
import type { CommandResult } from '../../platform/ipcContracts.ts';
import { commandResultError, friendlyError } from '../../shared/errorMessages.ts';
import type { NoticeMessage } from '../../hooks/useStatusNotice.ts';

type SettingsTransferApi = Pick<
  Window['api']['app'],
  'exportSettings' | 'importPreview' | 'importApply' | 'importDiscard'
>;

interface UseSettingsTransferOptions {
  applySettings: (settings: AppSettings) => void;
  refreshSites: () => unknown;
  reportError: (error: unknown) => void;
  appApi?: SettingsTransferApi;
}

/** Bookmarks whose passwords an import left behind, by reason. */
export interface ImportWarnings {
  /** The file sends them somewhere other than where the password was saved for. */
  scopeMismatches: string[];
  /** Already here more than once for the same server, so no single one was chosen. */
  unmatched: string[];
}

/**
 * What a step resolves to. `undefined` is cancelled, or failed and already
 * reported; the rest is for the dialog to answer.
 */
export type ExportOutcome =
  | { done: NoticeMessage }
  /** Bookmarks whose saved passwords this computer cannot open. */
  | { unreadable: string[] }
  | { vaultLocked: true }
  | undefined;

export type ImportOutcome =
  | { done: NoticeMessage; warnings: ImportWarnings | null }
  | { wrongPassword: true }
  | { vaultLocked: true }
  | undefined;

export interface SettingsTransferModel {
  exportSettings: (
    options: SettingsTransferOptions,
    secrets?: ExportSecrets,
  ) => Promise<ExportOutcome>;
  /** Chooses and checks the file. `hasSecrets`: ask for the file's password. */
  previewImport: (options: SettingsTransferOptions) => Promise<{ hasSecrets: boolean } | undefined>;
  /** Imports the previewed file; `password` null imports it without its passwords. */
  applyImport: (
    options: SettingsTransferOptions,
    password: string | null,
  ) => Promise<ImportOutcome>;
  /** Forgets the previewed file. */
  discardImport: () => void;
}

const PARTS = ['includeSettings', 'includeBookmarks', 'includeLocalPaths'] as const;

/** The file dialog closed, or the confirmation declined: the user knows, nothing to say. */
const cancelled = (result: CommandResult & { canceled?: boolean }) =>
  !!result.canceled || result.errorCode === 'cancelled';

export function useSettingsTransfer({
  applySettings,
  refreshSites,
  reportError,
  appApi = api.app,
}: UseSettingsTransferOptions): SettingsTransferModel {
  const { t } = useTranslation();
  const partNames = useCallback(
    (options: SettingsTransferOptions) =>
      PARTS.filter((part) => options[part])
        .map((part) => t(`exportSettingsDialog.${part}`))
        .join(t('statusBar.listSeparator')),
    [t],
  );

  /**
   * The code only says the file was refused. The backend's first reason
   * names the bookmark or the setting, which is what the user can act on,
   * so it follows the translated message as it came.
   */
  const reportFailure = useCallback(
    (result: CommandResult) => {
      const reason = result.diagnosticDetails?.split('\n')[0];
      const failure = commandResultError(result);
      reportError(reason ? `${friendlyError(failure) ?? ''} ${reason}` : failure);
    },
    [reportError],
  );

  const exportSettings = useCallback(
    async (options: SettingsTransferOptions, secrets?: ExportSecrets): Promise<ExportOutcome> => {
      const result = await appApi.exportSettings(options, secrets);
      if (!result.ok) {
        if (result.errorCode === 'savedSecretUnreadable')
          return { unreadable: result.diagnosticDetails?.split('\n').filter(Boolean) ?? [] };
        if (result.errorCode === 'vaultLocked') return { vaultLocked: true };
        if (!cancelled(result)) reportError(commandResultError(result));
        return undefined;
      }
      const sealed = result.secrets ?? 0;
      const phrase = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ');
      const passwords = sealed > 0 ? t('statusBar.transferPasswords', { count: sealed }) : null;
      return {
        done: {
          text: phrase(t('statusBar.exported', { parts: partNames(options) }), passwords),
          short: phrase(t('statusBar.exportedShort'), passwords),
        },
      };
    },
    [appApi, reportError, t, partNames],
  );

  const previewImport = useCallback(
    async (options: SettingsTransferOptions) => {
      const result = await appApi.importPreview(options);
      if (!result.ok) {
        if (!cancelled(result)) reportFailure(result);
        return undefined;
      }
      return { hasSecrets: !!result.hasSecrets };
    },
    [appApi, reportFailure],
  );

  const summary = useCallback(
    (options: SettingsTransferOptions, result: ImportSettingsResult): NoticeMessage => {
      const added = result.sitesAdded ?? 0;
      const skipped = result.sitesSkipped ?? 0;
      const passwords = (result.secretsSaved ?? 0) + (result.flagsRestored ?? 0);
      // Name only what actually came in: settings the file had, sites that were added.
      const imported = {
        includeSettings: options.includeSettings && !!result.settings,
        includeBookmarks: options.includeBookmarks && added > 0,
        includeLocalPaths: options.includeLocalPaths && added > 0,
      };
      const anything = imported.includeSettings || added > 0 || passwords > 0;
      const phrase = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ');
      const addedPart = added > 0 ? t('statusBar.importAdded', { count: added }) : null;
      const passwordsPart =
        passwords > 0 ? t('statusBar.transferPasswords', { count: passwords }) : null;
      // The short form drops what the parts were -- they were just ticked --
      // and keeps the numbers.
      return {
        text: phrase(
          !anything
            ? t('statusBar.importNothingNew')
            : added > 0 || imported.includeSettings
              ? t('statusBar.imported', { parts: partNames(imported) })
              : null,
          addedPart,
          passwordsPart,
          skipped > 0 ? t('statusBar.importSkipped', { count: skipped }) : null,
        ),
        short: phrase(
          t(anything ? 'statusBar.importedShort' : 'statusBar.importNothingNewShort'),
          addedPart,
          passwordsPart,
          skipped > 0 ? t('statusBar.importSkippedShort', { count: skipped }) : null,
        ),
      };
    },
    [t, partNames],
  );

  const applyImport = useCallback(
    async (options: SettingsTransferOptions, password: string | null): Promise<ImportOutcome> => {
      const result = await appApi.importApply(password);
      if (!result.ok) {
        if (result.errorCode === 'authFailed') return { wrongPassword: true };
        if (result.errorCode === 'vaultLocked') return { vaultLocked: true };
        if (!cancelled(result)) reportFailure(result);
        return undefined;
      }
      if (result.settings) applySettings(result.settings);
      if (result.sitesAdded || result.secretsSaved || result.flagsRestored) refreshSites();
      const warnings = {
        scopeMismatches: result.scopeMismatches ?? [],
        unmatched: result.unmatched ?? [],
      };
      return {
        done: summary(options, result),
        warnings:
          warnings.scopeMismatches.length > 0 || warnings.unmatched.length > 0 ? warnings : null,
      };
    },
    [appApi, applySettings, refreshSites, reportFailure, summary],
  );

  const discardImport = useCallback(() => {
    void appApi.importDiscard();
  }, [appApi]);

  return useMemo(
    () => ({ exportSettings, previewImport, applyImport, discardImport }),
    [exportSettings, previewImport, applyImport, discardImport],
  );
}
