import { useEffect } from 'react';
import type { SettingsState } from '../features/settings/index.ts';
import { setDateFormatPreference } from '../features/settings/index.ts';
import i18n, { changeLanguage } from '../i18n/index.ts';
import { api } from '../platform/api/index.ts';
import { applyInterfaceScale } from '../platform/interfaceScale.ts';
import { applyWindowTheme } from '../platform/windowFrame.ts';
import { reportRejection } from '../shared/asyncFailure.ts';
import type { Translate } from '../shared/types.ts';
import { installVaultAutoLock } from './vaultAutoLock.ts';

interface AppEffectsOptions {
  interface: SettingsState['interface'];
  vaultAutoLockMinutes: number;
  t: Translate;
}

export function useAppEffects({
  interface: { theme, language, interfaceScale, dateFormat },
  vaultAutoLockMinutes,
  t,
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
    reportRejection(api.tray.setLabels(t('tray.show'), t('tray.quit')));
  }, [language, t]);

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
    return installVaultAutoLock({
      minutes: vaultAutoLockMinutes,
      vault: api.vault,
      onLocked: () => window.dispatchEvent(new Event('ftpeach:vault-locked')),
    });
  }, [vaultAutoLockMinutes]);
}
