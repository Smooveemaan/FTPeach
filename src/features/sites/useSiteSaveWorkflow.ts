import { useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { SavedSite, SiteMutationResult } from '../../platform/api/sites.ts';
import type { PaneId, SiteForm } from '../../shared/types.ts';
import type { PaneSiteSource } from './useSites.ts';
import { createPaneSiteForm, normalizeSiteForm } from './siteForm.ts';
import { connectionIdentity } from './siteManagerModel.ts';

interface SavedSiteLink {
  siteId: string;
  siteLabel: string;
}

interface SiteSaveWorkflowOptions<Pane extends PaneSiteSource> {
  panes: Record<PaneId, Pane>;
  activeTabId: string;
  setShowSaveSite: Dispatch<SetStateAction<SiteForm | false>>;
  saveSite: (payload: SavedSite) => Promise<SiteMutationResult | undefined>;
  updatePane: (id: PaneId, patch: SavedSiteLink, tabId?: string) => void;
}

export interface SiteSaveWorkflowModel {
  handleSaveSite: (id: PaneId) => () => void;
  saveFromPane: (payload: SavedSite) => Promise<SiteMutationResult | undefined>;
}

// Saving the pane's connection turns it into that bookmark, so the pane, its
// tab and its transfer rows should caption it by the bookmark's name instead
// of the bare host. The save dialog can also edit some other entry from its
// list, or the destination itself, before saving — that bookmark is not what
// the pane is connected to, so only a matching destination is linked.
export function savedSiteLinkForPane(
  pane: PaneSiteSource,
  payload: SavedSite,
  result: SiteMutationResult | undefined,
): SavedSiteLink | null {
  if (!result?.ok || !result.id || pane.kind === 'local' || payload.kind === 'local') return null;
  const name = typeof payload.name === 'string' ? payload.name : '';
  const paneIdentity = connectionIdentity(normalizeSiteForm(createPaneSiteForm(pane)));
  if (paneIdentity !== connectionIdentity({ ...payload, name })) return null;
  return { siteId: result.id, siteLabel: name };
}

export function useSiteSaveWorkflow<Pane extends PaneSiteSource>({
  panes,
  activeTabId,
  setShowSaveSite,
  saveSite,
  updatePane,
}: SiteSaveWorkflowOptions<Pane>): SiteSaveWorkflowModel {
  const sourceRef = useRef<{ paneId: PaneId; tabId: string; pane: Pane } | null>(null);

  const handleSaveSite = (id: PaneId) => () => {
    sourceRef.current = { paneId: id, tabId: activeTabId, pane: panes[id] };
    setShowSaveSite(createPaneSiteForm(panes[id]));
  };

  const saveFromPane = async (payload: SavedSite) => {
    const result = await saveSite(payload);
    const source = sourceRef.current;
    const link = source ? savedSiteLinkForPane(source.pane, payload, result) : null;
    if (source && link) updatePane(source.paneId, link, source.tabId);
    return result;
  };

  return { handleSaveSite, saveFromPane };
}
