import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../components/Icon.tsx';
import ToolbarOverflowMenu from '../components/ToolbarOverflowMenu.tsx';
import { DIVIDER_WIDTH, ITEM_WIDTH, useOverflowFold } from '../hooks/useOverflowFold.ts';
import { effectiveBinding } from '../shortcuts/resolve.ts';
import { formatBinding } from '../shortcuts/bindings.ts';
import type { ShortcutOverrides } from '../shortcuts/resolve.ts';
import type { MenuItem } from '../components/MenuItems.tsx';

type PaneOrientation = 'horizontal' | 'vertical';
type Action = () => unknown;
type RefreshAction = () => unknown;

interface ViewToolbarProps {
  showLocalPane: boolean;
  toggleLocalPane: Action;
  showRemotePane: boolean;
  toggleRemotePane: Action;
  showTransferQueue: boolean;
  toggleTransferQueue: Action;
  logEnabled: boolean;
  toggleLog: Action;
  effectivePaneOrientation: PaneOrientation;
  paneOrientation: PaneOrientation;
  windowNarrow: boolean;
  togglePaneOrientation: Action;
  hasActiveTransfers: boolean;
  hasPausedTransfers: boolean;
  hasPausableTransfers: boolean;
  pauseAllTransfers: Action;
  resumeAllTransfers: (refreshTargets?: RefreshAction) => unknown;
  hasRetryableTransfers: boolean;
  stopAllTransfers: Action;
  retryAllTransfers: (refreshTargets?: RefreshAction) => unknown;
  refreshBothPanes: RefreshAction;
  keyboardShortcuts?: ShortcutOverrides | null;
}

export default function ViewToolbar({
  showLocalPane,
  toggleLocalPane,
  showRemotePane,
  toggleRemotePane,
  showTransferQueue,
  toggleTransferQueue,
  logEnabled,
  toggleLog,
  effectivePaneOrientation,
  paneOrientation,
  windowNarrow,
  togglePaneOrientation,
  hasActiveTransfers,
  hasPausedTransfers,
  hasPausableTransfers,
  pauseAllTransfers,
  resumeAllTransfers,
  hasRetryableTransfers,
  stopAllTransfers,
  retryAllTransfers,
  refreshBothPanes,
  keyboardShortcuts,
}: ViewToolbarProps) {
  const { t } = useTranslation();
  const containerRef = useRef(null);

  const foldOrder = [
    { key: 'refresh', width: ITEM_WIDTH },
    { key: 'orientation', width: ITEM_WIDTH },
    { key: 'log', width: ITEM_WIDTH },
    { key: 'queue', width: ITEM_WIDTH },
    { key: 'panelRight', width: ITEM_WIDTH },
    // Bundles the divider that would otherwise dangle alone once the whole
    // panel-toggle group (this item included) is gone.
    { key: 'panelLeft', width: ITEM_WIDTH + DIVIDER_WIDTH },
  ];
  // Pinned: pause/resume, stop/retry (2 buttons; the divider between them
  // and the panel-toggle group is conditional, see showDivider below).
  const baseWidth = 2 * ITEM_WIDTH;
  const { foldedKeys, hasOverflow } = useOverflowFold({ containerRef, baseWidth, foldOrder });

  // foldOrder folds a strict prefix ending in panelLeft — checking it alone
  // is enough to know the whole panel-toggle group is empty.
  const showDivider = !foldedKeys.has('panelLeft');

  const overflowItems: MenuItem[] = [
    ...(foldedKeys.has('panelLeft')
      ? [
          {
            label: t('menu.view.leftPane'),
            checked: showLocalPane,
            disabled: showLocalPane && !showRemotePane,
            onClick: toggleLocalPane,
          },
        ]
      : []),
    ...(foldedKeys.has('panelRight')
      ? [
          {
            label: t('menu.view.rightPane'),
            checked: showRemotePane,
            disabled: showRemotePane && !showLocalPane,
            onClick: toggleRemotePane,
          },
        ]
      : []),
    ...(foldedKeys.has('queue')
      ? [
          {
            label: t('menu.view.transferQueue'),
            checked: showTransferQueue,
            onClick: toggleTransferQueue,
          },
        ]
      : []),
    ...(foldedKeys.has('log')
      ? [{ label: t('menu.view.log'), checked: logEnabled, onClick: toggleLog }]
      : []),
    ...(foldedKeys.has('orientation')
      ? [
          {
            label: t('menu.view.stackedPanes'),
            checked: effectivePaneOrientation === 'vertical',
            disabled: windowNarrow,
            onClick: togglePaneOrientation,
          },
        ]
      : []),
    ...(foldedKeys.has('refresh')
      ? [
          {
            label: t('menu.view.refreshBothPanes'),
            shortcut: formatBinding(effectiveBinding('refresh', keyboardShortcuts)),
            onClick: refreshBothPanes,
          },
        ]
      : []),
  ];

  return (
    <div className="view-toolbar" data-tooltip-below ref={containerRef}>
      {!foldedKeys.has('panelLeft') && (
        <button
          type="button"
          className={`btn btn-ghost btn-icon ${showLocalPane ? 'active' : ''}`}
          data-tooltip={t('viewToolbar.toggleLeftPane')}
          onClick={toggleLocalPane}
          disabled={showLocalPane && !showRemotePane}
        >
          <Icon name="panelLeft" />
        </button>
      )}
      {!foldedKeys.has('panelRight') && (
        <button
          type="button"
          className={`btn btn-ghost btn-icon ${showRemotePane ? 'active' : ''}`}
          data-tooltip={t('viewToolbar.toggleRightPane')}
          onClick={toggleRemotePane}
          disabled={showRemotePane && !showLocalPane}
        >
          <Icon name="panelRight" />
        </button>
      )}
      {!foldedKeys.has('queue') && (
        <button
          type="button"
          className={`btn btn-ghost btn-icon ${showTransferQueue ? 'active' : ''}`}
          data-tooltip={t('viewToolbar.toggleTransferQueue')}
          onClick={toggleTransferQueue}
        >
          <Icon name="arrowDownUp" />
        </button>
      )}
      {!foldedKeys.has('log') && (
        <button
          type="button"
          className={`btn btn-ghost btn-icon ${logEnabled ? 'active' : ''}`}
          data-tooltip={t('viewToolbar.toggleLog')}
          onClick={toggleLog}
        >
          <Icon name="scrollText" />
        </button>
      )}
      {!foldedKeys.has('orientation') && (
        <button
          type="button"
          className={`btn btn-ghost btn-icon orientation-toggle ${effectivePaneOrientation === 'vertical' ? 'active' : ''}`}
          data-tooltip={
            windowNarrow
              ? t('viewToolbar.orientationNarrow')
              : paneOrientation === 'vertical'
                ? t('viewToolbar.orientationToRow')
                : t('viewToolbar.orientationToStacked')
          }
          onClick={togglePaneOrientation}
          disabled={windowNarrow}
        >
          <Icon name="rows" />
        </button>
      )}
      {showDivider && <span className="toolbar-divider" />}
      {hasActiveTransfers || !hasPausedTransfers ? (
        <button
          type="button"
          className={`btn btn-ghost btn-icon ${hasActiveTransfers && hasPausableTransfers ? 'armed' : ''}`}
          data-tooltip={
            hasActiveTransfers && !hasPausableTransfers
              ? t('viewToolbar.pauseUnsupportedWebdav')
              : t('viewToolbar.pauseActive')
          }
          onClick={pauseAllTransfers}
          disabled={!hasActiveTransfers || !hasPausableTransfers}
        >
          <Icon name="pause" />
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-ghost btn-icon armed"
          data-tooltip={t('viewToolbar.resumeAllPaused')}
          onClick={() => resumeAllTransfers(refreshBothPanes)}
        >
          <Icon name="play" />
        </button>
      )}
      {hasActiveTransfers || hasPausedTransfers || !hasRetryableTransfers ? (
        <button
          type="button"
          className={`btn btn-ghost btn-icon ${hasActiveTransfers || hasPausedTransfers ? 'armed' : ''}`}
          data-tooltip={t('viewToolbar.stopActive')}
          onClick={stopAllTransfers}
          disabled={!hasActiveTransfers && !hasPausedTransfers}
        >
          <Icon name="stop" />
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-ghost btn-icon armed"
          data-tooltip={t('viewToolbar.retryAllStopped')}
          onClick={() => retryAllTransfers(refreshBothPanes)}
        >
          <Icon name="play" />
        </button>
      )}
      {!foldedKeys.has('refresh') && (
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          data-tooltip={t('viewToolbar.refreshPanesTooltip')}
          onClick={refreshBothPanes}
        >
          <Icon name="refresh" />
        </button>
      )}
      <span className="toolbar-spacer" />
      {hasOverflow && <ToolbarOverflowMenu items={overflowItems} />}
    </div>
  );
}
