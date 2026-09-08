import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../platform/api/index.ts';
import { persistSetting } from '../../../platform/persistSetting.ts';
import { reportRejection } from '../../../shared/asyncFailure.ts';

export interface RecentSitesModel {
  recentSiteIds: string[];
  pushRecentSite: (siteId: string) => void;
}

export function useRecentSites(): RecentSitesModel {
  const [recentSiteIds, setRecentSiteIds] = useState<string[]>([]);

  useEffect(() => {
    reportRejection(
      api.settings.get().then((settings) => {
        if (Array.isArray(settings.recentSiteIds)) setRecentSiteIds(settings.recentSiteIds);
      }),
    );
  }, []);

  const pushRecentSite = useCallback((siteId: string) => {
    setRecentSiteIds((previous) => {
      const next = [siteId, ...previous.filter((id) => id !== siteId)];
      persistSetting({ recentSiteIds: next });
      return next;
    });
  }, []);

  return { recentSiteIds, pushRecentSite };
}
