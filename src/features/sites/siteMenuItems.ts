import type { MenuItem } from '../../components/MenuItems.tsx';
import type { ManagedSite, Translate } from '../../shared/types.ts';
import type { SiteDeleteTarget } from './useSiteManagerDialogState.ts';

export interface SiteMenuActions {
  onConnect: (site: ManagedSite) => void;
  onEdit: (site: ManagedSite) => void;
  onDuplicate: (site: ManagedSite) => void;
  onStartRenameSite: (site: ManagedSite) => void;
  onRequestDelete: (target: SiteDeleteTarget) => void;
}

/** Context-menu actions of one site, shared by the tree and the search results. */
export function siteMenuItems(
  site: ManagedSite,
  t: Translate,
  actions: SiteMenuActions,
): MenuItem[] {
  return [
    { label: t('connectionBar.connectTooltip.connect'), onClick: () => actions.onConnect(site) },
    { label: t('siteManagerDialog.titleEdit'), onClick: () => actions.onEdit(site) },
    { label: t('siteManagerDialog.duplicate'), onClick: () => actions.onDuplicate(site) },
    { label: t('filePane.rename'), onClick: () => actions.onStartRenameSite(site) },
    { separator: true },
    {
      label: t('paneMenu.delete'),
      danger: true,
      onClick: () => actions.onRequestDelete({ kind: 'site', id: site.id, name: site.name }),
    },
  ];
}
