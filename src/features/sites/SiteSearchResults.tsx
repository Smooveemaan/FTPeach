import { useState } from 'react';
import type { MouseEvent } from 'react';
import ContextMenu from '../../components/ContextMenu.tsx';
import type { MenuItem } from '../../components/MenuItems.tsx';
import { SiteRowBody } from './components/SiteRowBody.tsx';
import { siteMenuItems } from './siteMenuItems.ts';
import type { ManagedSite } from '../../shared/siteContracts.ts';
import type { Translate } from '../../shared/translate.ts';
import type { SiteDeleteTarget } from './useSiteManagerDialogState.ts';

interface SiteSearchResultsProps {
  sites: ManagedSite[];
  entriesById: Map<string, ManagedSite>;
  onConnect: (site: ManagedSite) => void;
  onEdit: (site: ManagedSite) => void;
  onDuplicate: (site: ManagedSite) => void;
  onRequestDelete: (target: SiteDeleteTarget) => void;
  renamingSiteId: string | null;
  renameSiteName: string;
  onRenameSiteNameChange: (name: string) => void;
  onCommitRenameSite: (site: ManagedSite) => void;
  onCancelRenameSite: () => void;
  onStartRenameSite: (site: ManagedSite) => void;
  t: Translate;
}

interface SearchContextMenu {
  x: number;
  y: number;
  items: MenuItem[];
}

export default function SiteSearchResults({
  sites,
  entriesById,
  onConnect,
  onEdit,
  onDuplicate,
  onRequestDelete,
  renamingSiteId,
  renameSiteName,
  onRenameSiteNameChange,
  onCommitRenameSite,
  onCancelRenameSite,
  onStartRenameSite,
  t,
}: SiteSearchResultsProps) {
  const [contextMenu, setContextMenu] = useState<SearchContextMenu | null>(null);

  const siteActions = { onConnect, onEdit, onDuplicate, onStartRenameSite, onRequestDelete };

  return (
    <>
      <div className="site-manage-list">
        <div className="site-manage-content">
          {sites.length === 0 ? (
            <div className="site-manager-empty">{t('siteManagerDialog.noSearchResults')}</div>
          ) : (
            sites.map((site) => {
              const parent = site.parentId ? entriesById.get(site.parentId) : null;
              const items = siteMenuItems(site, t, siteActions);
              const isRenaming = renamingSiteId === site.id;
              return (
                <div
                  key={site.id}
                  className="site-manage-row is-site"
                  data-kind="site"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({ x: event.clientX, y: event.clientY, items });
                  }}
                  // Same click-to-connect convention as SiteTree's rows —
                  // ignores clicks on the row's own action buttons/rename input.
                  onClick={(e: MouseEvent<HTMLDivElement>) => {
                    if (e.target instanceof Element && e.target.closest('button, input')) return;
                    onConnect(site);
                  }}
                >
                  <SiteRowBody
                    site={site}
                    detail={parent?.name}
                    isRenaming={isRenaming}
                    renameName={renameSiteName}
                    onRenameNameChange={onRenameSiteNameChange}
                    onCommitRename={() => onCommitRenameSite(site)}
                    onCancelRename={onCancelRenameSite}
                    onConnect={onConnect}
                    onEdit={onEdit}
                    onDuplicate={onDuplicate}
                    onRequestDelete={onRequestDelete}
                    t={t}
                  />
                </div>
              );
            })
          )}
        </div>
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}
