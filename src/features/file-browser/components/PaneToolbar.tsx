import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../components/Icon.tsx';
import ToolbarOverflowMenu from '../../../components/ToolbarOverflowMenu.tsx';
import type { MenuItem } from '../../../components/MenuItems.tsx';
import { DIVIDER_WIDTH, ITEM_WIDTH, useOverflowFold } from '../../../hooks/useOverflowFold.ts';

interface PaneToolbarProps {
  isLocal: boolean;
  disconnected: boolean;
  /** The protocol cannot create a named file safely, so the action is refused. */
  newFileUnsupported: boolean;
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
  newFileUnsupported,
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
  // The reason stands in for the label, so the answer is there before a name is typed.
  const newFileLabel = newFileUnsupported
    ? t('errors.createUnsupported')
    : t('paneToolbar.newFile');
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
            ? [
                {
                  label: newFileLabel,
                  disabled: disconnected || newFileUnsupported,
                  onClick: onNewFile,
                },
              ]
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
          aria-label={homeLabel}
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
          aria-label={t('paneToolbar.back')}
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
          aria-label={t('paneToolbar.forward')}
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
          aria-label={t('paneToolbar.up')}
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
          aria-label={t('paneToolbar.chooseFolder')}
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
          aria-label={t('paneToolbar.newFolder')}
          onClick={onNewFolder}
          disabled={disconnected}
        >
          <Icon name="folderPlus" />
        </button>
      )}
      {!foldedKeys.has('newFile') && (
        <button
          className="btn btn-ghost btn-icon"
          data-tooltip={newFileLabel}
          aria-label={newFileLabel}
          onClick={onNewFile}
          disabled={disconnected || newFileUnsupported}
        >
          <Icon name="filePlus" />
        </button>
      )}
      {!foldedKeys.has('copy') && (
        <button
          className="btn btn-primary btn-icon btn-primary-quiet"
          data-tooltip={copyLabel}
          aria-label={copyLabel}
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
          aria-label={deleteLabel}
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
