import { useState } from 'react';
import type { MouseEvent } from 'react';
import ContextMenu from '../../components/ContextMenu.tsx';
import type { MenuItem } from '../../components/MenuItems.tsx';
import Icon from '../../components/Icon.tsx';
import type { IconName } from '../../components/Icon.tsx';
import TruncatedText from '../../components/TruncatedText.tsx';
import { siteMeta } from './siteMeta.ts';
import type { ManagedSite, Translate } from '../../shared/types.ts';
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

  const getMenuItems = (site: ManagedSite): MenuItem[] => [
    { label: t('connectionBar.connectTooltip.connect'), onClick: () => onConnect(site) },
    { label: t('siteManagerDialog.titleEdit'), onClick: () => onEdit(site) },
    { label: t('siteManagerDialog.duplicate'), onClick: () => onDuplicate(site) },
    { label: t('filePane.rename'), onClick: () => onStartRenameSite(site) },
    { separator: true },
    {
      label: t('paneMenu.delete'),
      danger: true,
      onClick: () => onRequestDelete({ kind: 'site', id: site.id, name: site.name }),
    },
  ];

  return (
    <>
      <div className="site-manage-list">
        <div className="site-manage-content">
          {sites.length === 0 ? (
            <div className="site-manager-empty">{t('siteManagerDialog.noSearchResults')}</div>
          ) : (
            sites.map((site) => {
              const parent = site.parentId ? entriesById.get(site.parentId) : null;
              const items = getMenuItems(site);
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
                  <Icon
                    name={(site.icon || 'bookmark') as IconName}
                    size={14}
                    color={site.color || undefined}
                  />
                  {isRenaming ? (
                    <input
                      type="text"
                      autoFocus
                      className="folder-name-input"
                      aria-label={t('filePane.rename')}
                      value={renameSiteName}
                      onChange={(e) => onRenameSiteNameChange(e.target.value)}
                      onBlur={() => onCommitRenameSite(site)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                        if (e.key === 'Escape') onCancelRenameSite();
                      }}
                    />
                  ) : (
                    <div className="site-info" data-tooltip={siteMeta(site)}>
                      <TruncatedText as="div" className="site-name">
                        {site.name}
                      </TruncatedText>
                      {parent && (
                        <TruncatedText as="div" className="site-search-parent">
                          {parent.name}
                        </TruncatedText>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon site-manage-row-btn"
                    aria-label={t('connectionBar.connectTooltip.connect')}
                    data-tooltip={t('connectionBar.connectTooltip.connect')}
                    onClick={() => onConnect(site)}
                  >
                    <Icon name="play" size={12} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon site-manage-row-btn"
                    aria-label={t('siteManagerDialog.titleEdit')}
                    data-tooltip={t('siteManagerDialog.titleEdit')}
                    onClick={() => onEdit(site)}
                  >
                    <Icon name="pencil" size={12} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon site-manage-row-btn"
                    aria-label={t('siteManagerDialog.duplicate')}
                    data-tooltip={t('siteManagerDialog.duplicate')}
                    onClick={() => onDuplicate(site)}
                  >
                    <Icon name="copy" size={12} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon site-manage-row-btn"
                    aria-label={t('paneMenu.delete')}
                    data-tooltip={t('paneMenu.delete')}
                    onClick={() => onRequestDelete({ kind: 'site', id: site.id, name: site.name })}
                  >
                    <Icon name="trash" size={12} />
                  </button>
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
