import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { detectSystemLanguage } from '../i18n/index.ts';
import { api } from '../platform/api/index.ts';
import type { AppSettings, createSettingsApi } from '../platform/api/settings.ts';
import type { createSitesApi } from '../platform/api/sites.ts';
import type { ManagedSite } from '../shared/types.ts';

type SettingsApi = ReturnType<typeof createSettingsApi>;
type SitesApi = ReturnType<typeof createSitesApi>;

export function resolveBootstrapSettings(
  settings: AppSettings,
  detectLanguage: () => string = detectSystemLanguage,
) {
  if (settings.language) return { settings, detectedLanguage: null };
  const detectedLanguage = detectLanguage();
  return { settings: { ...settings, language: detectedLanguage }, detectedLanguage };
}

export function pendingSecurityNotices(settings: AppSettings) {
  return {
    legacy: !settings.legacyPasswordNoticeShown,
    plaintext: !settings.plaintextSecretNoticeShown,
  };
}

export interface AppBootstrapModel {
  sites: ManagedSite[];
  refreshSites: () => Promise<ManagedSite[]>;
  legacyPasswordNotice: boolean;
  setLegacyPasswordNotice: Dispatch<SetStateAction<boolean>>;
  plaintextSecretNotice: boolean;
  setPlaintextSecretNotice: Dispatch<SetStateAction<boolean>>;
  secretNotPersistedNotice: boolean;
  setSecretNotPersistedNotice: Dispatch<SetStateAction<boolean>>;
}

export function useAppBootstrap({
  applySettings,
  settingsApi = api.settings,
  sitesApi = api.sites,
}: {
  applySettings: (settings: AppSettings) => unknown;
  settingsApi?: SettingsApi;
  sitesApi?: SitesApi;
}): AppBootstrapModel {
  const [sites, setSites] = useState<ManagedSite[]>([]);
  const [legacyPasswordNotice, setLegacyPasswordNotice] = useState(false);
  const [plaintextSecretNotice, setPlaintextSecretNotice] = useState(false);
  const [secretNotPersistedNotice, setSecretNotPersistedNotice] = useState(false);
  const applySettingsRef = useRef(applySettings);
  const sitesRequestIdRef = useRef(0);
  applySettingsRef.current = applySettings;

  const refreshSites = useCallback(async () => {
    const requestId = ++sitesRequestIdRef.current;
    const nextSites = await sitesApi.list();
    if (requestId === sitesRequestIdRef.current) setSites(nextSites);
    return nextSites;
  }, [sitesApi]);

  useEffect(() => {
    let cancelled = false;
    const sitesRequestId = ++sitesRequestIdRef.current;

    Promise.all([settingsApi.get(), sitesApi.list()])
      .then(async ([storedSettings, storedSites]) => {
        if (cancelled) return;
        const { settings, detectedLanguage } = resolveBootstrapSettings(storedSettings);
        applySettingsRef.current(settings);
        if (sitesRequestId === sitesRequestIdRef.current) setSites(storedSites);
        // Awaited rather than fired and forgotten so a failed write joins the
        // bootstrap chain's own .catch below instead of vanishing.
        if (detectedLanguage) await settingsApi.set({ language: detectedLanguage });

        const pending = pendingSecurityNotices(storedSettings);
        const [hasLegacySecret, hasPlaintextSecret] = await Promise.all([
          pending.legacy ? sitesApi.hasLegacySecret() : false,
          pending.plaintext ? sitesApi.hasPlaintextSecret() : false,
        ]);
        // Set by this effect's cleanup, which the compiler does not model.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (cancelled) return;

        if (hasLegacySecret) {
          setLegacyPasswordNotice(true);
          await settingsApi.set({ legacyPasswordNoticeShown: true });
        }
        if (hasPlaintextSecret) {
          setPlaintextSecretNotice(true);
          await settingsApi.set({ plaintextSecretNoticeShown: true });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) console.error('App bootstrap failed', error);
      });

    return () => {
      cancelled = true;
    };
  }, [settingsApi, sitesApi]);

  return {
    sites,
    refreshSites,
    legacyPasswordNotice,
    setLegacyPasswordNotice,
    plaintextSecretNotice,
    setPlaintextSecretNotice,
    secretNotPersistedNotice,
    setSecretNotPersistedNotice,
  };
}
