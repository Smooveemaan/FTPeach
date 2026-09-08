import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../components/Icon.tsx';
import ToolbarOverflowMenu from '../../../components/ToolbarOverflowMenu.tsx';
import type { MenuItem } from '../../../components/MenuItems.tsx';
import { DIVIDER_WIDTH, ITEM_WIDTH, useOverflowFold } from '../../../hooks/useOverflowFold.ts';

interface PaneToolbarProps {
  isLocal: boolean;
  disconnected: boolean;
  homeLabel: string;
  canGoBack: boolean;
  canGoForward: boolean;
  hasSelection: boolean;
  copyDisabled: boolean;
  copyLabel: string;
  onHome: () => unknown;
  onBack: () => unknown;
  onForward: () => unknown;
  onUp: () => unknown;
  onChooseFolder?: (() => unknown) | undefined;
  onNewFolder: () => unknown;
  onNewFile: () => unknown;
  onDelete: () => unknown;
  onCopy: () => unknown;
}

export default function PaneToolbar({
  isLocal,
  disconnected,
  homeLabel,
  canGoBack,
  canGoForward,
  hasSelection,
  copyDisabled,
  copyLabel,
  onHome,
  onBack,
  onForward,
  onUp,
  onChooseFolder,
  onNewFolder,
  onNewFile,
  onDelete,
  onCopy,
}: PaneToolbarProps) {
  const { t, i18n } = useTranslation();
  const rtl = i18n.dir() === 'rtl';
  const deleteLabel = t('paneMenu.delete');
  const containerRef = useRef<HTMLDivElement>(null);

  const foldOrder = [
    { key: 'trash', width: ITEM_WIDTH },
    { key: 'copy', width: ITEM_WIDTH },
    { key: 'newFile', width: ITEM_WIDTH },
    // Bundles the divider that would otherwise sit alone once the whole
    // filesystem-ops group (this item included) is gone.
    { key: 'newFolder', width: ITEM_WIDTH + DIVIDER_WIDTH },
    ...(isLocal ? [{ key: 'chooseFolder', width: ITEM_WIDTH }] : []),
    { key: 'up', width: ITEM_WIDTH },
    { key: 'forward', width: ITEM_WIDTH },
    { key: 'back', width: ITEM_WIDTH },
    { key: 'home', width: ITEM_WIDTH },
  ];
  // Pinned: only the leading divider (search box | toolbar boundary).
  const baseWidth = DIVIDER_WIDTH;
  const { foldedKeys, hasOverflow } = useOverflowFold({ containerRef, baseWidth, foldOrder });

  const showDivider = !foldedKeys.has('newFolder');

  const overflowItems: MenuItem[] = [
    ...(foldedKeys.has('home')
      ? [{ label: homeLabel, disabled: disconnected, onClick: onHome }]
      : []),
    ...(foldedKeys.has('back')
      ? [{ label: t('paneToolbar.back'), disabled: disconnected || !canGoBack, onClick: onBack }]
      : []),
    ...(foldedKeys.has('forward')
      ? [
          {
            label: t('paneToolbar.forward'),
            disabled: disconnected || !canGoForward,
            onClick: onForward,
          },
        ]
      : []),
    ...(foldedKeys.has('up')
      ? [{ label: t('paneToolbar.up'), disabled: disconnected, onClick: onUp }]
      : []),
    ...(foldedKeys.has('chooseFolder')
      ? [{ label: t('paneToolbar.chooseFolder'), onClick: onChooseFolder }]
      : []),
    ...(foldedKeys.has('newFolder') ||
    foldedKeys.has('newFile') ||
    foldedKeys.has('trash') ||
    foldedKeys.has('copy')
      ? [
          ...(foldedKeys.has('home') ||
          foldedKeys.has('back') ||
          foldedKeys.has('forward') ||
          foldedKeys.has('up') ||
          foldedKeys.has('chooseFolder')
            ? [{ separator: true }]
            : []),
          ...(foldedKeys.has('newFolder')
            ? [{ label: t('paneToolbar.newFolder'), disabled: disconnected, onClick: onNewFolder }]
            : []),
          ...(foldedKeys.has('newFile')
            ? [{ label: t('paneToolbar.newFile'), disabled: disconnected, onClick: onNewFile }]
            : []),
          ...(foldedKeys.has('copy')
            ? [{ label: copyLabel, disabled: copyDisabled, onClick: onCopy }]
            : []),
          ...(foldedKeys.has('trash')
            ? [{ label: deleteLabel, danger: true, disabled: !hasSelection, onClick: onDelete }]
            : []),
        ]
      : []),
  ];

  return (
    <div className={`pane-toolbar ${hasOverflow ? 'has-overflow' : ''}`} ref={containerRef}>
      <span className="toolbar-divider" />
      {!foldedKeys.has('home') && (
        <button
          className="btn btn-ghost btn-icon"
          data-tooltip={homeLabel}
          onClick={onHome}
          disabled={disconnected}
        >
          <Icon name="house" />
        </button>
      )}
      {!foldedKeys.has('back') && (
        <button
          className="btn btn-ghost btn-icon"
          data-tooltip={t('paneToolbar.back')}
          onClick={onBack}
          disabled={disconnected || !canGoBack}
        >
          <Icon name={rtl ? 'chevronRight' : 'chevronLeft'} />
        </button>
      )}
      {!foldedKeys.has('forward') && (
        <button
          className="btn btn-ghost btn-icon"
          data-tooltip={t('paneToolbar.forward')}
          onClick={onForward}
          disabled={disconnected || !canGoForward}
        >
          <Icon name={rtl ? 'chevronLeft' : 'chevronRight'} />
        </button>
      )}
      {!foldedKeys.has('up') && (
        <button
          className="btn btn-ghost btn-icon"
          data-tooltip={t('paneToolbar.up')}
          onClick={onUp}
          disabled={disconnected}
        >
          <Icon name="chevronUp" />
        </button>
      )}
      {isLocal && !foldedKeys.has('chooseFolder') && (
        <button
          className="btn btn-ghost btn-icon"
          data-tooltip={t('paneToolbar.chooseFolder')}
          onClick={onChooseFolder}
        >
          <Icon name="folder" />
        </button>
      )}
      {showDivider && <span className="toolbar-divider" />}
      {!foldedKeys.has('newFolder') && (
        <button
          className="btn btn-ghost btn-icon"
          data-tooltip={t('paneToolbar.newFolder')}
          onClick={onNewFolder}
          disabled={disconnected}
        >
          <Icon name="folderPlus" />
        </button>
      )}
      {!foldedKeys.has('newFile') && (
        <button
          className="btn btn-ghost btn-icon"
          data-tooltip={t('paneToolbar.newFile')}
          onClick={onNewFile}
          disabled={disconnected}
        >
          <Icon name="filePlus" />
        </button>
      )}
      {!foldedKeys.has('copy') && (
        <button
          className="btn btn-primary btn-icon btn-primary-quiet"
          data-tooltip={copyLabel}
          onClick={onCopy}
          disabled={copyDisabled}
        >
          <Icon name="copy" />
        </button>
      )}
      {!foldedKeys.has('trash') && (
        <button
          className="btn btn-danger btn-icon"
          data-tooltip={deleteLabel}
          onClick={onDelete}
          disabled={!hasSelection}
        >
          <Icon name="trash" />
        </button>
      )}
      {hasOverflow && <ToolbarOverflowMenu items={overflowItems} />}
    </div>
  );
}
