import Icon from '../../../components/Icon.tsx';
import type { IconName } from '../../../components/Icon.tsx';
import TruncatedText from '../../../components/TruncatedText.tsx';
import type { ManagedSite } from '../../../shared/siteContracts.ts';
import type { Translate } from '../../../shared/translate.ts';
import { siteMeta } from '../siteMeta.ts';
import type { SiteDeleteTarget } from '../useSiteManagerDialogState.ts';

interface RowRenameInputProps {
  label: string;
  value: string;
  onChange: (name: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

/** Renames a row in place: Enter or leaving the field saves, Escape cancels. */
export function RowRenameInput({
  label,
  value,
  onChange,
  onCommit,
  onCancel,
}: RowRenameInputProps) {
  return (
    <input
      type="text"
      autoFocus
      className="folder-name-input"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    />
  );
}

interface SiteRowBodyProps {
  site: ManagedSite;
  /** A second line under the name, such as the folder a search result is in. */
  detail?: string | undefined;
  isRenaming: boolean;
  renameName: string;
  onRenameNameChange: (name: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onConnect: (site: ManagedSite) => void;
  onEdit: (site: ManagedSite) => void;
  onDuplicate: (site: ManagedSite) => void;
  onRequestDelete: (target: SiteDeleteTarget) => void;
  t: Translate;
}

/** What a bookmark row shows, in the tree and in search results alike. */
export function SiteRowBody({
  site,
  detail,
  isRenaming,
  renameName,
  onRenameNameChange,
  onCommitRename,
  onCancelRename,
  onConnect,
  onEdit,
  onDuplicate,
  onRequestDelete,
  t,
}: SiteRowBodyProps) {
  return (
    <>
      <Icon
        name={(site.icon || 'bookmark') as IconName}
        size={14}
        color={site.color || undefined}
      />
      {isRenaming ? (
        <RowRenameInput
          label={t('filePane.rename')}
          value={renameName}
          onChange={onRenameNameChange}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      ) : (
        <div className="site-info" data-tooltip={siteMeta(site)}>
          <TruncatedText as="div" className="site-name">
            <bdi>{site.name}</bdi>
          </TruncatedText>
          {detail && (
            <TruncatedText as="div" className="site-search-parent">
              {detail}
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
        <Icon name="play" size={14} />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon site-manage-row-btn"
        aria-label={t('siteManagerDialog.titleEdit')}
        data-tooltip={t('siteManagerDialog.titleEdit')}
        onClick={() => onEdit(site)}
      >
        <Icon name="pencil" size={14} />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon site-manage-row-btn"
        aria-label={t('siteManagerDialog.duplicate')}
        data-tooltip={t('siteManagerDialog.duplicate')}
        onClick={() => onDuplicate(site)}
      >
        <Icon name="copy" size={14} />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon site-manage-row-btn site-manage-row-delete"
        aria-label={t('paneMenu.delete')}
        data-tooltip={t('paneMenu.delete')}
        onClick={() => onRequestDelete({ kind: 'site', id: site.id, name: site.name })}
      >
        <Icon name="trash" size={14} />
      </button>
    </>
  );
}
