import i18n from '../i18n/index.ts';
import { effectiveBinding } from '../shortcuts/resolve.ts';
import { formatBinding } from '../shortcuts/bindings.ts';
import type { MenuBarEntry } from '../components/MenuBar.tsx';
import type { PaneState, TabState } from '../features/file-browser/index.ts';
import type { PaneId } from '../shared/types.ts';
import type { ShortcutOverrides } from '../shortcuts/resolve.ts';
import type { PaneOrientation } from '../features/settings/index.ts';
import { handler } from '../shared/asyncFailure.ts';
import { api } from '../platform/api/index.ts';

export interface MenusContext {
  modalOpen: boolean;
  openNewTab: () => unknown;
  tabs: TabState[];
  closeTab: (tabId: string) => unknown;
  reopenClosedTab: () => unknown;
  canReopenClosedTab: boolean;
  activeTabId: string;
  freeConnectTargetPaneId: PaneId | null;
  startPaneConnect: (id: PaneId) => unknown;
  soleConnectedRemotePane: PaneState | null;
  connectedRemotePanes: PaneState[];
  connectionLabels?: ReadonlyMap<string | null, string>;
  disconnectPane: (id: PaneId) => unknown;
  handleSaveSite: (id: PaneId) => () => unknown;
  setShowExportSettings: (show: boolean) => unknown;
  setShowImportSettings: (show: boolean) => unknown;
  theme: string;
  changeTheme: (theme: string) => unknown;
  resetLayout: () => unknown;
  syncBrowsing: boolean;
  syncEligible: boolean;
  toggleSync: () => unknown;
  showHiddenFiles: boolean;
  toggleHiddenFiles: () => unknown;
  showLocalPane: boolean;
  toggleLocalPane: () => unknown;
  showRemotePane: boolean;
  toggleRemotePane: () => unknown;
  showTransferQueue: boolean;
  toggleTransferQueue: () => unknown;
  logEnabled: boolean;
  toggleLog: () => unknown;
  effectivePaneOrientation: PaneOrientation;
  windowNarrow: boolean;
  togglePaneOrientation: () => unknown;
  refreshBothPanes: () => unknown;
  panes: Record<PaneId, PaneState>;
  canCopyBetween: (source: PaneState, target: PaneState) => boolean;
  copySelectedWithConfirm: (
    source: PaneState,
    target: PaneState,
    refreshSource: () => unknown,
    refreshTarget: () => unknown,
  ) => unknown;
  hasCompletedTransfers: boolean;
  clearCompletedTransfers: () => unknown;
  refreshPane: (id: PaneId, path: string) => unknown;
  openSiteManager: () => unknown;
  openLocalPathManager: () => unknown;
  openSettings: () => unknown;
  openAbout: () => unknown;
  checkForUpdates: () => unknown;
  keyboardShortcuts?: ShortcutOverrides | null;
}

export function buildMenus(ctx: MenusContext): MenuBarEntry[] {
  const t = i18n.t.bind(i18n);
  const {
    modalOpen,
    openNewTab,
    tabs,
    closeTab,
    reopenClosedTab,
    canReopenClosedTab,
    activeTabId,
    freeConnectTargetPaneId,
    startPaneConnect,
    soleConnectedRemotePane,
    disconnectPane,
    handleSaveSite,
    setShowExportSettings,
    setShowImportSettings,
    theme,
    changeTheme,
    resetLayout,
    syncBrowsing,
    syncEligible,
    toggleSync,
    showHiddenFiles,
    toggleHiddenFiles,
    showLocalPane,
    toggleLocalPane,
    showRemotePane,
    toggleRemotePane,
    showTransferQueue,
    toggleTransferQueue,
    logEnabled,
    toggleLog,
    effectivePaneOrientation,
    windowNarrow,
    togglePaneOrientation,
    refreshBothPanes,
    panes,
    canCopyBetween,
    copySelectedWithConfirm,
    hasCompletedTransfers,
    clearCompletedTransfers,
    refreshPane,
    openSiteManager,
    openLocalPathManager,
    openSettings,
    openAbout,
    checkForUpdates,
    keyboardShortcuts,
  } = ctx;

  const shortcutLabel = (actionId: string) =>
    formatBinding(effectiveBinding(actionId, keyboardShortcuts));

  const paneSideWord = (id: PaneId) =>
    effectivePaneOrientation === 'vertical'
      ? id === 'a'
        ? t('paneSide.top')
        : t('paneSide.bottom')
      : id === 'a'
        ? t('paneSide.left')
        : t('paneSide.right');

  // save-site (pane a) / save-site-secondary (pane b) are side-fixed, not
  // kind-fixed — each saves whatever that side currently holds.
  const canSaveSide = (id: PaneId) =>
    panes[id].kind === 'local' ? true : panes[id].status === 'connected';

  const saveSiteItems = (['a', 'b'] as const).map((id) => ({
    label: t(panes[id].kind === 'local' ? 'menu.file.savePathSide' : 'menu.file.saveBookmarkSide', {
      side: paneSideWord(id),
    }),
    shortcut: id === 'a' ? shortcutLabel('save-site') : shortcutLabel('save-site-secondary'),
    disabled: !canSaveSide(id),
    onClick: () => canSaveSide(id) && handleSaveSite(id)(),
  }));

  return [
    {
      label: t('menu.file.title'),
      items: [
        {
          label: t('menu.file.newTab'),
          shortcut: shortcutLabel('new-tab'),
          disabled: modalOpen,
          onClick: openNewTab,
        },
        {
          label: t('menu.file.closeTab'),
          shortcut: shortcutLabel('close-tab'),
          disabled: modalOpen || tabs.length === 1,
          onClick: () => closeTab(activeTabId),
        },
        {
          label: t('menu.file.reopenClosedTab'),
          shortcut: shortcutLabel('reopen-closed-tab'),
          disabled: modalOpen || !canReopenClosedTab,
          onClick: reopenClosedTab,
        },
        { separator: true },
        {
          label: t('menu.file.newConnection'),
          shortcut: shortcutLabel('new-connection'),
          disabled: !freeConnectTargetPaneId,
          onClick: () => freeConnectTargetPaneId && startPaneConnect(freeConnectTargetPaneId),
        },
        {
          label: t('menu.file.disconnect'),
          disabled: !soleConnectedRemotePane,
          onClick: () => soleConnectedRemotePane && disconnectPane(soleConnectedRemotePane.id),
        },
        { separator: true },
        { label: t('menu.file.exportSettings'), onClick: () => setShowExportSettings(true) },
        { label: t('menu.file.importSettings'), onClick: () => setShowImportSettings(true) },
        { separator: true },
        { label: t('menu.file.quit'), onClick: () => window.close() },
      ],
    },
    {
      label: t('menu.edit.title'),
      items: [
        {
          label: t('menu.edit.settings'),
          shortcut: shortcutLabel('open-settings'),
          onClick: openSettings,
        },
        { separator: true },
        { label: t('menu.edit.resetLayout'), onClick: resetLayout },
      ],
    },
    {
      label: t('menu.view.title'),
      items: [
        {
          label: t('menu.view.lightTheme'),
          checked: theme === 'light',
          onClick: () => changeTheme('light'),
        },
        {
          label: t('menu.view.darkTheme'),
          checked: theme === 'dark',
          onClick: () => changeTheme('dark'),
        },
        {
          label: t('menu.view.systemTheme'),
          checked: theme === 'system',
          onClick: () => changeTheme('system'),
        },
        { separator: true },
        {
          label: t('menu.view.syncBrowsing'),
          checked: syncBrowsing,
          disabled: !syncEligible,
          onClick: toggleSync,
        },
        {
          label: t('menu.view.showHiddenFiles'),
          shortcut: shortcutLabel('toggle-hidden-files'),
          checked: showHiddenFiles,
          onClick: toggleHiddenFiles,
        },
        { separator: true },
        {
          label: t('menu.view.leftPane'),
          checked: showLocalPane,
          disabled: showLocalPane && !showRemotePane,
          onClick: toggleLocalPane,
        },
        {
          label: t('menu.view.rightPane'),
          checked: showRemotePane,
          disabled: showRemotePane && !showLocalPane,
          onClick: toggleRemotePane,
        },
        {
          label: t('menu.view.transferQueue'),
          checked: showTransferQueue,
          onClick: toggleTransferQueue,
        },
        { label: t('menu.view.log'), checked: logEnabled, onClick: toggleLog },
        {
          label: t('menu.view.stackedPanes'),
          checked: effectivePaneOrientation === 'vertical',
          disabled: windowNarrow,
          onClick: togglePaneOrientation,
        },
        { separator: true },
        {
          label: t('menu.view.refreshBothPanes'),
          shortcut: shortcutLabel('refresh'),
          onClick: refreshBothPanes,
        },
      ],
    },
    {
      label: t('menu.transfer.title'),
      items: [
        {
          label: t('menu.transfer.copySelectedRight'),
          disabled: !canCopyBetween(panes.a, panes.b) || panes.a.selected.size === 0,
          onClick: () =>
            copySelectedWithConfirm(
              panes.a,
              panes.b,
              () => refreshPane('a', panes.a.path),
              () => refreshPane('b', panes.b.path),
            ),
        },
        {
          label: t('menu.transfer.copySelectedLeft'),
          disabled: !canCopyBetween(panes.b, panes.a) || panes.b.selected.size === 0,
          onClick: () =>
            copySelectedWithConfirm(
              panes.b,
              panes.a,
              () => refreshPane('b', panes.b.path),
              () => refreshPane('a', panes.a.path),
            ),
        },
        { separator: true },
        {
          label: t('menu.transfer.clearCompleted'),
          disabled: !hasCompletedTransfers,
          onClick: clearCompletedTransfers,
        },
      ],
    },
    {
      label: t('menu.bookmarks.title'),
      items: [
        { label: t('menu.file.manageBookmarks'), onClick: openSiteManager },
        { label: t('siteManagerDialog.manageLocalPaths'), onClick: openLocalPathManager },
        { separator: true },
        ...saveSiteItems,
      ],
    },
    {
      label: t('menu.help.title'),
      items: [
        {
          label: t('menu.help.documentation'),
          onClick: handler(() =>
            api.app.openExternal('https://github.com/Smooveemaan/ftpeach#readme'),
          ),
        },
        {
          label: t('menu.help.reportIssue'),
          onClick: handler(() =>
            api.app.openExternal('https://github.com/Smooveemaan/ftpeach/issues/new'),
          ),
        },
        {
          label: t('menu.help.supportProject'),
          onClick: handler(() => api.app.openExternal('https://ko-fi.com/smooveemaan')),
        },
        { separator: true },
        { label: t('menu.help.checkUpdates'), onClick: checkForUpdates },
        { label: t('menu.help.about'), onClick: openAbout },
      ],
    },
  ];
}
