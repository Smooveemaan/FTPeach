import { useEffect } from 'react';
import type { SettingsState } from '../features/settings/index.ts';
import { setDateFormatPreference } from '../features/settings/index.ts';
import { setDoubleClickMs } from '../features/file-browser/index.ts';
import { terminalStore } from '../features/terminal/index.ts';
import { changeLanguage } from '../i18n/index.ts';
import { reportAsyncFailure } from '../shared/asyncFailure.ts';
import { api } from '../platform/api/index.ts';
import { applyInterfaceScale } from '../platform/interfaceScale.ts';
import { applyAppearance } from '../shared/appearance.ts';
import { applyWindowTheme } from '../platform/windowFrame.ts';
import { observeSystemTheme } from '../platform/systemTheme.ts';
import { installVaultActivityReporting } from './vaultAutoLock.ts';

interface AppEffectsOptions {
  interface: SettingsState['interface'];
}

export function useAppEffects({
  interface: {
    theme,
    colorScheme,
    language,
    interfaceScale,
    fileListScale,
    terminalFontSize,
    dateFormat,
  },
}: AppEffectsOptions): void {
  useEffect(() => {
    void api.app.doubleClickTime().then(setDoubleClickMs, reportAsyncFailure);
  }, []);

  useEffect(() => {
    const applyResolvedTheme = (resolved: string) => {
      applyAppearance(resolved, colorScheme);
      applyWindowTheme(theme);
      terminalStore.updateTheme();
    };
    if (theme === 'system') return observeSystemTheme(applyResolvedTheme);
    applyResolvedTheme(theme);
    return undefined;
  }, [theme, colorScheme]);

  useEffect(() => {
    // The latest language wins inside changeLanguage, which also sets the
    // document's lang and dir with it; a locale that fails to load keeps the
    // current one and says why.
    changeLanguage(language).catch(reportAsyncFailure);
  }, [language]);

  useEffect(() => {
    void applyInterfaceScale(interfaceScale).catch(reportAsyncFailure);
  }, [interfaceScale]);

  useEffect(() => {
    document.documentElement.style.setProperty('--file-list-scale', String(fileListScale / 100));
  }, [fileListScale]);

  useEffect(() => {
    terminalStore.setFontSize(terminalFontSize);
  }, [terminalFontSize]);

  useEffect(() => {
    setDateFormatPreference(dateFormat);
    if (dateFormat !== 'locale') return;
    let cancelled = false;
    void api.app.systemHourCycle().then((hourCycle) => {
      if (!cancelled) setDateFormatPreference(dateFormat, hourCycle);
    });
    return () => {
      cancelled = true;
    };
  }, [dateFormat]);

  useEffect(() => {
    // The backend owns the idle timeout and locks on a Windows session lock
    // or a hidden window, whatever this window is doing; this only tells it
    // when the user was last seen.
    return installVaultActivityReporting({ vault: api.vault });
  }, []);
}
