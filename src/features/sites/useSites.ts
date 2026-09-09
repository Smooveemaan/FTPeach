import { useCallback, useMemo } from 'react';
import { api } from '../../platform/api/index.ts';
import type {
  SavedSite,
  SiteLayout,
  SiteMutationResult,
  createSitesApi,
} from '../../platform/api/sites.ts';
import { commandResultError } from '../../shared/errorMessages.ts';
import type { ConnectionForm, ManagedSite } from '../../shared/types.ts';

type SitesApi = ReturnType<typeof createSitesApi>;

interface UseSitesOptions {
  sites: ManagedSite[];
  recentSiteIds: string[];
  refreshSites: () => Promise<ManagedSite[]>;
  reportError: (error: unknown) => void;
  onSecretNotPersisted: () => void;
  sitesApi?: SitesApi;
}

interface RefreshOptions {
  returnResult?: boolean;
  secret?: boolean;
}

export interface PaneSiteSource {
  kind?: 'local' | 'remote';
  form: ConnectionForm;
  path: string;
}

export function orderConnectableSites(
  sites: readonly ManagedSite[],
  recentSiteIds: readonly string[],
): ManagedSite[] {
  const connectable = sites.filter((site) => site.kind !== 'folder' && site.kind !== 'local');
  const recent = recentSiteIds
    .map((id) => connectable.find((site) => site.id === id))
    .filter((site): site is ManagedSite => site != null);
  return [
    ...recent,
    ...connectable
      .slice()
      .reverse()
      .filter((site) => !recent.some((item) => item.id === site.id)),
  ];
}

export function buildPaneSitePayload(
  name: string,
  pane: PaneSiteSource,
  sites: readonly ManagedSite[],
): SavedSite {
  const defaultPort = pane.form.protocol === 'sftp' ? 22 : 21;
  const parsedPort = Number(pane.form.port);
  const port = pane.form.port && !Number.isNaN(parsedPort) ? parsedPort : defaultPort;
  const existing = sites.find(
    (site) =>
      site.name === name ||
      (site.protocol === pane.form.protocol &&
        site.host === pane.form.host &&
        site.port === port &&
        site.user === pane.form.user &&
        (pane.form.protocol !== 'webdav' || site.webdavUrl === pane.form.webdavUrl)),
  );
  return {
    ...(existing === undefined ? {} : { id: existing.id }),
    name,
    protocol: pane.form.protocol,
    host: pane.form.host,
    port,
    webdavUrl: pane.form.webdavUrl,
    user: pane.form.user,
    password: pane.form.password,
    allowInvalidCert: pane.form.allowInvalidCert,
    caCertPath: pane.form.caCertPath,
    remotePath: pane.path,
    useKeyAuth: pane.form.useKeyAuth,
    keyPath: pane.form.keyPath,
    keyPassphrase: pane.form.keyPassphrase,
  };
}

export interface SitesModel {
  connectableSites: ManagedSite[];
  localPaths: ManagedSite[];
  orderedSites: ManagedSite[];
  savePaneSite: (name: string, pane: PaneSiteSource) => Promise<SiteMutationResult | undefined>;
  saveLocalPath: (name: string, path: string) => Promise<SiteMutationResult | undefined>;
  saveSite: (payload: SavedSite) => Promise<SiteMutationResult | undefined>;
  deleteSite: (id: string) => Promise<SiteMutationResult | undefined>;
  saveFolder: (payload: SavedSite) => Promise<SiteMutationResult | undefined>;
  deleteFolder: (id: string) => Promise<SiteMutationResult | undefined>;
  applyLayout: (layout: SiteLayout) => Promise<SiteMutationResult | undefined>;
}

export function useSites({
  sites,
  recentSiteIds,
  refreshSites,
  reportError,
  onSecretNotPersisted,
  sitesApi = api.sites,
}: UseSitesOptions): SitesModel {
  const orderedSites = useMemo(
    () => orderConnectableSites(sites, recentSiteIds),
    [recentSiteIds, sites],
  );
  const connectableSites = useMemo(
    () => sites.filter((site) => site.kind !== 'folder' && site.kind !== 'local'),
    [sites],
  );
  const localPaths = useMemo(() => sites.filter((site) => site.kind === 'local'), [sites]);

  const refreshAfterSuccess = useCallback(
    async (
      operation: Promise<SiteMutationResult>,
      { returnResult = false, secret = false }: RefreshOptions = {},
    ) => {
      const result = await operation;
      if (!result.ok) {
        if (!returnResult) reportError(commandResultError(result));
        return returnResult ? result : undefined;
      }
      if (secret && result.secretNotPersisted) onSecretNotPersisted();
      await refreshSites();
      return returnResult ? result : undefined;
    },
    [onSecretNotPersisted, refreshSites, reportError],
  );

  return {
    connectableSites,
    localPaths,
    orderedSites,
    savePaneSite: (name: string, pane: PaneSiteSource) =>
      refreshAfterSuccess(sitesApi.save(buildPaneSitePayload(name, pane, connectableSites)), {
        secret: true,
      }),
    saveLocalPath: (name: string, path: string) => {
      const existing = localPaths.find((site) => site.name === name || site.localPath === path);
      return refreshAfterSuccess(
        sitesApi.save({
          ...(existing === undefined ? {} : { id: existing.id }),
          kind: 'local',
          name,
          localPath: path,
          parentId: existing?.parentId || null,
          icon: existing?.icon || 'bookmark',
          color: existing?.color || '',
        }),
        { returnResult: true },
      );
    },
    saveSite: (payload: SavedSite) =>
      refreshAfterSuccess(sitesApi.save(payload), { returnResult: true, secret: true }),
    deleteSite: (id: string) => refreshAfterSuccess(sitesApi.delete(id), { returnResult: true }),
    saveFolder: (payload: SavedSite) =>
      refreshAfterSuccess(sitesApi.saveFolder(payload), { returnResult: true }),
    deleteFolder: (id: string) =>
      refreshAfterSuccess(sitesApi.deleteFolder(id), { returnResult: true }),
    applyLayout: (layout: SiteLayout) =>
      refreshAfterSuccess(sitesApi.applyLayout(layout), { returnResult: true }),
  };
}
