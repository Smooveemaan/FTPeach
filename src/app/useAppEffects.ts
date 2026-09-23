import { useEffect } from 'react';
import type { SettingsState } from '../features/settings/index.ts';
import { setDateFormatPreference } from '../features/settings/index.ts';
import i18n, { changeLanguage } from '../i18n/index.ts';
import { api } from '../platform/api/index.ts';
import { applyInterfaceScale } from '../platform/interfaceScale.ts';
import { applyWindowTheme } from '../platform/windowFrame.ts';
import { installVaultActivityReporting } from './vaultAutoLock.ts';

interface AppEffectsOptions {
  interface: SettingsState['interface'];
}

export function useAppEffects({
  interface: { theme, language, interfaceScale, dateFormat },
}: AppEffectsOptions): void {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyResolvedTheme = () => {
      const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      document.documentElement.setAttribute('data-theme', resolved);
      applyWindowTheme(theme);
    };
    applyResolvedTheme();
    if (theme !== 'system') return;
    media.addEventListener('change', applyResolvedTheme);
    return () => media.removeEventListener('change', applyResolvedTheme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    void changeLanguage(language).then((resolvedLanguage) => {
      if (cancelled) return;
      document.documentElement.lang = resolvedLanguage;
      document.documentElement.dir = i18n.dir(resolvedLanguage);
    });
    return () => {
      cancelled = true;
    };
  }, [language]);

  useEffect(() => {
    void applyInterfaceScale(interfaceScale);
    const updateViewportVars = () => {
      document.documentElement.style.setProperty('--app-viewport-w', `${window.innerWidth}px`);
      document.documentElement.style.setProperty('--app-viewport-h', `${window.innerHeight}px`);
    };
    updateViewportVars();
    window.addEventListener('resize', updateViewportVars);
    return () => window.removeEventListener('resize', updateViewportVars);
  }, [interfaceScale]);

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
    // or a hidden window, whatever this window is doing; both effects here
    // only keep the UI in step with it.
    const stopReporting = installVaultActivityReporting({ vault: api.vault });
    const stopListening = api.vault.onLocked(() =>
      window.dispatchEvent(new Event('ftpeach:vault-locked')),
    );
    return () => {
      stopReporting();
      stopListening();
    };
  }, []);
}
