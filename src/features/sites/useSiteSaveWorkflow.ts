import type { Dispatch, SetStateAction } from 'react';
import type { PaneId, SiteForm } from '../../shared/types.ts';
import type { PaneSiteSource } from './useSites.ts';
import { createPaneSiteForm } from './siteForm.ts';

interface SiteSaveWorkflowOptions<Pane extends PaneSiteSource> {
  panes: Record<PaneId, Pane>;
  setShowSaveSite: Dispatch<SetStateAction<SiteForm | false>>;
}

export interface SiteSaveWorkflowModel {
  handleSaveSite: (id: PaneId) => () => void;
}

export function useSiteSaveWorkflow<Pane extends PaneSiteSource>({
  panes,
  setShowSaveSite,
}: SiteSaveWorkflowOptions<Pane>): SiteSaveWorkflowModel {
  const handleSaveSite = (id: PaneId) => () => {
    setShowSaveSite(createPaneSiteForm(panes[id]));
  };

  return { handleSaveSite };
}
