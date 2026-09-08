import type { Dispatch, SetStateAction } from 'react';
import type { PaneId } from '../../shared/types.ts';
import type { PaneSiteSource } from './useSites.ts';

interface SiteSaveWorkflowOptions<Pane extends PaneSiteSource> {
  panes: Record<PaneId, Pane>;
  showSaveSite: PaneId | false;
  setShowSaveSite: Dispatch<SetStateAction<PaneId | false>>;
  savePaneSite: (name: string, pane: Pane) => unknown;
  saveLocalPath: (name: string, path: string) => unknown;
}

export interface SiteSaveWorkflowModel {
  handleSaveSite: (id: PaneId) => () => void;
  submitSaveSite: (name: string) => Promise<void>;
}

export function useSiteSaveWorkflow<Pane extends PaneSiteSource>({
  panes,
  showSaveSite,
  setShowSaveSite,
  savePaneSite,
  saveLocalPath,
}: SiteSaveWorkflowOptions<Pane>): SiteSaveWorkflowModel {
  const handleSaveSite = (id: PaneId) => () => {
    setShowSaveSite(id);
  };

  const submitSaveSite = async (name: string) => {
    const id = showSaveSite;
    if (!id) return;
    const pane = panes[id];
    if (pane.kind === 'local') await saveLocalPath(name, pane.path);
    else await savePaneSite(name, pane);
  };

  return { handleSaveSite, submitSaveSite };
}
