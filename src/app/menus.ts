import i18n from '../i18n/index.ts';
import { effectiveBinding } from '../shortcuts/resolve.ts';
import { formatBinding } from '../shortcuts/bindings.ts';
import type { MenuBarEntry } from '../components/MenuBar.tsx';
import type { MutableRefObject } from 'react';
import type {
  FileClipboardModel,
  FileSearchHandle,
  PanesModel,
} from '../features/file-browser/index.ts';
import { connectionLabel } from '../shared/siteContracts.ts';
import type { SettingsState } from '../features/settings/index.ts';
import type { TransfersModel } from '../features/transfers/index.ts';
import type { PaneId } from '../shared/paneContracts.ts';
import type { QuitWhenIdleModel } from './quit/useQuitWhenIdle.ts';
import type { AppDialogs } from './useAppDialogs.ts';
import type { ApplicationSettingsResult } from './useApplicationSettings.ts';
import type { WorkspaceLayoutModel } from './useWorkspaceLayout.ts';
import { handler } from '../shared/asyncFailure.ts';
import { api } from '../platform/api/index.ts';

/**
 * Everything the menu bar and the global shortcuts act on, as the objects
 * that own it. Both are built from this one context, so a command a menu
 * entry and a shortcut share is written once, in `applicationCommands`.
 */
export interface ApplicationCommandContext {
  /** A dialog that resolves against the active tab is open. */
  modalOpen: boolean;
  settings: {
    interface: Pick<SettingsState['interface'], 'theme'>;
    layout: Pick<
      SettingsState['layout'],
      'showHiddenFiles' | 'showLocalPane' | 'showRemotePane' | 'showTransferQueue'
    >;
    logging: Pick<SettingsState['logging'], 'logEnabled'>;
    shortcuts: Pick<SettingsState['shortcuts'], 'keyboardShortcuts'>;
  };
  browser: Pick<
    PanesModel,
    | 'tabs'
    | 'activeTabId'
    | 'setActiveTabId'
    | 'openNewTab'
    | 'closeTab'
    | 'reopenClosedTab'
    | 'canReopenClosedTab'
    | 'freeConnectTargetPaneId'
    | 'startPaneConnect'
    | 'connectedRemotePanes'
    | 'disconnectPane'
    | 'syncBrowsing'
    | 'syncEligible'
    | 'toggleSync'
    | 'refreshBothPanes'
    | 'panes'
    | 'canCopyBetween'
    | 'refreshPane'
  >;
  clipboard: Pick<FileClipboardModel, 'copySelectedWithConfirm'>;
  workspace: Pick<
    WorkspaceLayoutModel,
    | 'toggleLocalPane'
    | 'toggleRemotePane'
    | 'toggleTransferQueue'
    | 'toggleHiddenFiles'
    | 'toggleLog'
    | 'togglePaneOrientation'
    | 'effectivePaneOrientation'
    | 'windowNarrow'
  >;
  dialogs: Pick<
    AppDialogs,
    | 'setShowSettings'
    | 'setShowAbout'
    | 'setShowSiteManagerDialog'
    | 'setShowLocalPathManagerDialog'
    | 'setShowExportSettings'
    | 'setShowImportSettings'
    | 'requestConfirm'
  >;
  transfers: Pick<TransfersModel, 'hasCompletedTransfers' | 'clearCompletedTransfers'>;
  applicationSettings: Pick<ApplicationSettingsResult, 'changeTheme'>;
  searchInputRefs: Record<PaneId, MutableRefObject<FileSearchHandle | null>>;
  /** Opens the dialog that saves a pane as a bookmark or a local path. */
  saveSite: (id: PaneId) => () => unknown;
  /** Quits the application, asking first while transfers run; never hides to the tray. */
  quit: Pick<QuitWhenIdleModel, 'request'>;
  resetLayout: () => unknown;
  checkForUpdates: () => unknown;
}

/** The commands a menu entry and a global shortcut both run. */
function applicationCommands({ browser, dialogs, saveSite }: ApplicationCommandContext) {
  // save-site (pane a) / save-site-secondary (pane b) are side-fixed, not
  // kind-fixed — each saves whatever that side currently holds. A server side
  // needs what its Save Connection button needs: an address, connected or not.
  const canSaveSide = (id: PaneId) => {
    const { kind, status, form } = browser.panes[id];
    if (kind === 'local' || status === 'connected') return true;
    return Boolean(form.protocol === 'webdav' ? form.webdavUrl : form.host);
  };
  return {
    canSaveSide,
    saveSide: (id: PaneId) => canSaveSide(id) && saveSite(id)(),
    // A pane in use is not dropped by a keystroke: the user is asked first.
    newConnection: (id: PaneId) => {
      const pane = browser.panes[id];
      if (pane.kind !== 'remote' || (pane.status !== 'connected' && pane.status !== 'connecting')) {
        browser.startPaneConnect(id);
        return;
      }
      dialogs.requestConfirm(
        i18n.t('confirm.newConnectionReplaces', { current: connectionLabel(pane) }),
        () => browser.startPaneConnect(id),
        { confirmLabel: i18n.t('confirm.replaceConnectionLabel'), danger: true },
      );
    },
    openSettings: () => dialogs.setShowSettings(true),
  };
}

/** What each global shortcut runs, by its action id in `shortcuts/registry.ts`. */
export function applicationShortcuts(ctx: ApplicationCommandContext) {
  const { browser, workspace, searchInputRefs } = ctx;
  const commands = applicationCommands(ctx);
  const cycleTab = (step: 1 | -1) => {
    const { tabs, activeTabId } = browser;
    if (tabs.length < 2) return;
    const index = tabs.findIndex((tab) => tab.id === activeTabId);
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (next) browser.setActiveTabId(next.id);
  };
  return {
    'search-local': () => searchInputRefs.a.current?.toggle(),
    'search-remote': () => searchInputRefs.b.current?.toggle(),
    'toggle-hidden-files': workspace.toggleHiddenFiles,
    'new-connection': () => commands.newConnection('a'),
    'new-connection-secondary': () => commands.newConnection('b'),
    refresh: browser.refreshBothPanes,
    'save-site': () => commands.saveSide('a'),
    'save-site-secondary': () => commands.saveSide('b'),
    'open-settings': commands.openSettings,
    'new-tab': browser.openNewTab,
    'close-tab': () => browser.tabs.length > 1 && browser.closeTab(browser.activeTabId),
    'reopen-closed-tab': browser.reopenClosedTab,
    'next-tab': () => cycleTab(1),
    'prev-tab': () => cycleTab(-1),
  };
}

export function buildMenus(ctx: ApplicationCommandContext): MenuBarEntry[] {
  const t = i18n.t.bind(i18n);
  const { modalOpen, settings, browser, clipboard, workspace, dialogs, transfers } = ctx;
  const { tabs, panes } = browser;
  const { keyboardShortcuts } = settings.shortcuts;
  const { effectivePaneOrientation } = workspace;
  const commands = applicationCommands(ctx);

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

  const saveSiteItems = (['a', 'b'] as const).map((id) => ({
    id: `save-site-${id}`,
    label: t(
      panes[id].kind === 'local' ? 'menu.file.savePathSide' : 'menu.file.saveConnectionSide',
      {
        side: paneSideWord(id),
      },
    ),
    shortcut: id === 'a' ? shortcutLabel('save-site') : shortcutLabel('save-site-secondary'),
    disabled: !commands.canSaveSide(id),
    onClick: () => commands.saveSide(id),
  }));

  // One server is "the" connection; with one on each side the menu names both.
  const connected = browser.connectedRemotePanes;
  const disconnectItems =
    connected.length > 1
      ? connected.map((pane) => ({
          id: `disconnect-${pane.id}`,
          label: t('paneSide.labelWithSide', {
            base: t('menu.file.disconnect'),
            side: paneSideWord(pane.id),
          }),
          onClick: () => void browser.disconnectPane(pane.id),
        }))
      : [
          {
            id: 'disconnect',
            label: t('menu.file.disconnect'),
            disabled: connected.length === 0,
            onClick: () => {
              const pane = connected[0];
              if (pane) void browser.disconnectPane(pane.id);
            },
          },
        ];

  return [
    {
      id: 'file',
      label: t('menu.file.title'),
      items: [
        {
          id: 'new-tab',
          label: t('menu.file.newTab'),
          shortcut: shortcutLabel('new-tab'),
          disabled: modalOpen,
          onClick: browser.openNewTab,
        },
        {
          id: 'close-tab',
          label: t('menu.file.closeTab'),
          shortcut: shortcutLabel('close-tab'),
          disabled: modalOpen || tabs.length === 1,
          onClick: () => browser.closeTab(browser.activeTabId),
        },
        {
          id: 'reopen-closed-tab',
          label: t('menu.file.reopenClosedTab'),
          shortcut: shortcutLabel('reopen-closed-tab'),
          disabled: modalOpen || !browser.canReopenClosedTab,
          onClick: browser.reopenClosedTab,
        },
        { separator: true },
        ...(['a', 'b'] as const).map((id) => ({
          id: `new-connection-${id}`,
          label: t('paneSide.labelWithSide', {
            base: t('menu.file.newConnection'),
            side: paneSideWord(id),
          }),
          shortcut: shortcutLabel(id === 'a' ? 'new-connection' : 'new-connection-secondary'),
          onClick: () => commands.newConnection(id),
        })),
        ...disconnectItems,
        { separator: true },
        {
          id: 'export-settings',
          label: t('menu.file.exportSettings'),
          onClick: () => dialogs.setShowExportSettings(true),
        },
        {
          id: 'import-settings',
          label: t('menu.file.importSettings'),
          onClick: () => dialogs.setShowImportSettings(true),
        },
        { separator: true },
        { id: 'quit', label: t('menu.file.quit'), onClick: () => ctx.quit.request() },
      ],
    },
    {
      id: 'edit',
      label: t('menu.edit.title'),
      items: [
        {
          id: 'open-settings',
          label: t('menu.edit.settings'),
          shortcut: shortcutLabel('open-settings'),
          onClick: commands.openSettings,
        },
        { separator: true },
        { id: 'reset-layout', label: t('menu.edit.resetLayout'), onClick: ctx.resetLayout },
      ],
    },
    {
      id: 'view',
      label: t('menu.view.title'),
      items: [
        {
          id: 'theme-light',
          label: t('menu.view.lightTheme'),
          checked: settings.interface.theme === 'light',
          radio: true,
          onClick: () => ctx.applicationSettings.changeTheme('light'),
        },
        {
          id: 'theme-dark',
          label: t('menu.view.darkTheme'),
          checked: settings.interface.theme === 'dark',
          radio: true,
          onClick: () => ctx.applicationSettings.changeTheme('dark'),
        },
        {
          id: 'theme-system',
          label: t('menu.view.systemTheme'),
          checked: settings.interface.theme === 'system',
          radio: true,
          onClick: () => ctx.applicationSettings.changeTheme('system'),
        },
        { separator: true },
        {
          id: 'sync-browsing',
          label: t('menu.view.syncBrowsing'),
          checked: browser.syncBrowsing,
          disabled: !browser.syncEligible,
          onClick: browser.toggleSync,
        },
        {
          id: 'show-hidden-files',
          label: t('menu.view.showHiddenFiles'),
          shortcut: shortcutLabel('toggle-hidden-files'),
          checked: settings.layout.showHiddenFiles,
          onClick: workspace.toggleHiddenFiles,
        },
        { separator: true },
        {
          id: 'toggle-left-pane',
          label: t('menu.view.leftPane'),
          checked: settings.layout.showLocalPane,
          disabled: settings.layout.showLocalPane && !settings.layout.showRemotePane,
          onClick: workspace.toggleLocalPane,
        },
        {
          id: 'toggle-right-pane',
          label: t('menu.view.rightPane'),
          checked: settings.layout.showRemotePane,
          disabled: settings.layout.showRemotePane && !settings.layout.showLocalPane,
          onClick: workspace.toggleRemotePane,
        },
        {
          id: 'toggle-transfer-queue',
          label: t('menu.view.transferQueue'),
          checked: settings.layout.showTransferQueue,
          onClick: workspace.toggleTransferQueue,
        },
        {
          id: 'toggle-log',
          label: t('menu.view.log'),
          checked: settings.logging.logEnabled,
          onClick: workspace.toggleLog,
        },
        {
          id: 'toggle-stacked-panes',
          label: t('menu.view.stackedPanes'),
          checked: effectivePaneOrientation === 'vertical',
          disabled: workspace.windowNarrow,
          onClick: workspace.togglePaneOrientation,
        },
        { separator: true },
        {
          id: 'refresh-both-panes',
          label: t('menu.view.refreshBothPanes'),
          shortcut: shortcutLabel('refresh'),
          onClick: browser.refreshBothPanes,
        },
      ],
    },
    {
      id: 'transfer',
      label: t('menu.transfer.title'),
      items: [
        {
          id: 'copy-selected-right',
          label: t('menu.transfer.copySelectedRight'),
          disabled: !browser.canCopyBetween(panes.a, panes.b) || panes.a.selected.size === 0,
          onClick: () =>
            void clipboard.copySelectedWithConfirm(
              panes.a,
              panes.b,
              () => browser.refreshPane('a', panes.a.path),
              () => browser.refreshPane('b', panes.b.path),
            ),
        },
        {
          id: 'copy-selected-left',
          label: t('menu.transfer.copySelectedLeft'),
          disabled: !browser.canCopyBetween(panes.b, panes.a) || panes.b.selected.size === 0,
          onClick: () =>
            void clipboard.copySelectedWithConfirm(
              panes.b,
              panes.a,
              () => browser.refreshPane('b', panes.b.path),
              () => browser.refreshPane('a', panes.a.path),
            ),
        },
        { separator: true },
        {
          id: 'clear-completed',
          label: t('menu.transfer.clearCompleted'),
          disabled: !transfers.hasCompletedTransfers,
          onClick: transfers.clearCompletedTransfers,
        },
      ],
    },
    {
      id: 'bookmarks',
      label: t('menu.bookmarks.title'),
      items: [
        {
          id: 'manage-bookmarks',
          label: t('menu.file.manageBookmarks'),
          onClick: () => dialogs.setShowSiteManagerDialog(true),
        },
        {
          id: 'manage-local-paths',
          label: t('siteManagerDialog.manageLocalPaths'),
          onClick: () => dialogs.setShowLocalPathManagerDialog(true),
        },
        { separator: true },
        ...saveSiteItems,
      ],
    },
    {
      id: 'help',
      label: t('menu.help.title'),
      items: [
        {
          id: 'user-guide',
          label: t('menu.help.userGuide'),
          onClick: handler(() => api.app.openExternal('https://ftpeach.com/guide/')),
        },
        {
          id: 'documentation',
          label: t('menu.help.documentation'),
          onClick: handler(() =>
            api.app.openExternal(
              'https://github.com/Smooveemaan/ftpeach/blob/master/docs/README.md',
            ),
          ),
        },
        {
          id: 'report-issue',
          label: t('menu.help.reportIssue'),
          onClick: handler(() =>
            api.app.openExternal('https://github.com/Smooveemaan/ftpeach/issues/new/choose'),
          ),
        },
        {
          id: 'support-project',
          label: t('menu.help.supportProject'),
          onClick: handler(() => api.app.openExternal('https://ftpeach.com/#support')),
        },
        { separator: true },
        { id: 'check-updates', label: t('menu.help.checkUpdates'), onClick: ctx.checkForUpdates },
        { id: 'about', label: t('menu.help.about'), onClick: () => dialogs.setShowAbout(true) },
      ],
    },
  ];
}
