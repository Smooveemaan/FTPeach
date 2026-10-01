import assert from 'node:assert/strict';
import test from 'node:test';
import { applicationShortcuts, buildMenus } from '../../../src/app/menus.ts';
import type { ApplicationCommandContext } from '../../../src/app/menus.ts';
import { makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';
import i18n from '../../../src/i18n/index.ts';

function harness() {
  const tab = makeTab('active');
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const ctx: ApplicationCommandContext = {
    modalOpen: false,
    settings: {
      interface: { theme: 'dark' },
      layout: {
        showHiddenFiles: false,
        showLocalPane: true,
        showRemotePane: true,
        showTransferQueue: true,
      },
      logging: { logEnabled: false },
      shortcuts: { keyboardShortcuts: {} },
    },
    browser: {
      tabs: [tab],
      activeTabId: tab.id,
      setActiveTabId: record('activate'),
      openNewTab: record('new'),
      closeTab: record('close'),
      reopenClosedTab: record('reopen'),
      canReopenClosedTab: false,
      freeConnectTargetPaneId: 'b',
      startPaneConnect: record('connect'),
      soleConnectedRemotePane: null,
      disconnectPane: async (id) => record('disconnect')(id),
      syncBrowsing: false,
      syncEligible: false,
      toggleSync: record('sync'),
      refreshBothPanes: record('refreshBoth'),
      panes: tab.panes,
      canCopyBetween: () => true,
      refreshPane: async (...args) => record('refresh')(...args),
    },
    clipboard: {
      copySelectedWithConfirm: async (source, target, refreshSource, refreshTarget) => {
        record('copy')(source.id, target.id);
        refreshSource();
        refreshTarget();
      },
    },
    workspace: {
      toggleLocalPane: record('local'),
      toggleRemotePane: record('remote'),
      toggleTransferQueue: record('queue'),
      toggleHiddenFiles: record('hidden'),
      toggleLog: record('log'),
      togglePaneOrientation: record('orientation'),
      effectivePaneOrientation: 'horizontal',
      windowNarrow: false,
    },
    dialogs: {
      setShowSettings: record('settings'),
      setShowAbout: record('about'),
      setShowSiteManagerDialog: record('sites'),
      setShowLocalPathManagerDialog: record('paths'),
      setShowExportSettings: record('export'),
      setShowImportSettings: record('import'),
    },
    transfers: { hasCompletedTransfers: false, clearCompletedTransfers: record('clear') },
    applicationSettings: { changeTheme: record('theme') },
    searchInputRefs: { a: { current: null }, b: { current: null } },
    saveSite: (id) => () => record('save')(id),
    quit: { request: record('quit') },
    resetLayout: record('reset'),
    checkForUpdates: record('updates'),
  };
  const item = (key: string) => {
    const found = buildMenus(ctx)
      .flatMap((menu) => menu.items)
      .find((entry) => entry.label === i18n.t(key));
    assert.ok(found, key);
    return found;
  };
  return { ctx, calls, item };
}

test('menus have translated ordered groups and well-formed actions and separators', () => {
  const h = harness();
  const menus = buildMenus(h.ctx);
  assert.deepEqual(
    menus.map((menu) => menu.label),
    ['file', 'edit', 'view', 'transfer', 'bookmarks', 'help'].map((key) =>
      i18n.t(`menu.${key}.title`),
    ),
  );
  for (const menu of menus) {
    assert.ok(!menu.items[0]!.separator && !menu.items.at(-1)!.separator);
    menu.items.forEach((item, index) => {
      if (item.separator) assert.ok(!menu.items[index - 1]?.separator);
      else {
        assert.ok(item.label);
        assert.equal(typeof item.onClick, 'function');
      }
    });
  }
});

test('menu commands bind current tab, pane and theme and both copy refresh callbacks', () => {
  const h = harness();
  for (const key of [
    'menu.file.newTab',
    'menu.file.closeTab',
    'menu.file.reopenClosedTab',
    'menu.file.newConnection',
    'menu.file.exportSettings',
    'menu.file.importSettings',
    'menu.file.quit',
    'menu.view.lightTheme',
    'menu.edit.settings',
    'menu.help.about',
    'menu.help.checkUpdates',
  ])
    h.item(key).onClick!();
  h.item('menu.transfer.copySelectedRight').onClick!();
  h.item('menu.transfer.copySelectedLeft').onClick!();
  assert.deepEqual(h.calls.slice(0, 11), [
    ['new'],
    ['close', 'active'],
    ['reopen'],
    ['connect', 'b'],
    ['export', true],
    ['import', true],
    ['quit'],
    ['theme', 'light'],
    ['settings', true],
    ['about', true],
    ['updates'],
  ]);
  assert.deepEqual(h.calls.slice(11), [
    ['copy', 'a', 'b'],
    ['refresh', 'a', h.ctx.browser.panes.a.path],
    ['refresh', 'b', h.ctx.browser.panes.b.path],
    ['copy', 'b', 'a'],
    ['refresh', 'b', h.ctx.browser.panes.b.path],
    ['refresh', 'a', h.ctx.browser.panes.a.path],
  ]);
});

test('availability tracks modal, selection, connected panes and the last visible pane', () => {
  const h = harness();
  assert.equal(h.item('menu.file.closeTab').disabled, true);
  assert.equal(h.item('menu.file.disconnect').disabled, true);
  assert.equal(h.item('menu.transfer.copySelectedRight').disabled, true);
  h.ctx.browser.panes.a.selected.add('file');
  assert.equal(h.item('menu.transfer.copySelectedRight').disabled, false);
  h.ctx.browser.tabs.push(makeTab('second'));
  assert.equal(h.item('menu.file.closeTab').disabled, false);
  assert.equal(h.item('menu.file.reopenClosedTab').disabled, true);
  h.ctx.browser.canReopenClosedTab = true;
  assert.equal(h.item('menu.file.reopenClosedTab').disabled, false);
  h.ctx.modalOpen = true;
  assert.equal(h.item('menu.file.newTab').disabled, true);
  assert.equal(h.item('menu.file.closeTab').disabled, true);
  assert.equal(h.item('menu.file.reopenClosedTab').disabled, true);
  h.ctx.settings.layout.showRemotePane = false;
  assert.equal(h.item('menu.view.leftPane').disabled, true);
  h.ctx.workspace.windowNarrow = true;
  assert.equal(h.item('menu.view.stackedPanes').disabled, true);
  h.ctx.browser.soleConnectedRemotePane = h.ctx.browser.panes.b;
  h.item('menu.file.disconnect').onClick!();
  assert.deepEqual(h.calls, [['disconnect', 'b']]);
});

test('shortcut overrides and unbinding propagate into menu labels', () => {
  const h = harness();
  h.ctx.settings.shortcuts.keyboardShortcuts = { 'new-tab': 'Alt+KeyN', 'close-tab': '' };
  assert.equal(h.item('menu.file.newTab').shortcut, 'Alt+N');
  assert.equal(h.item('menu.file.closeTab').shortcut, '');
  assert.equal(h.item('menu.file.reopenClosedTab').shortcut, 'Ctrl+Shift+T');
});

test('with a server on each side, either side is saved as a bookmark once it is connected', () => {
  const h = harness();
  const { a, b } = h.ctx.browser.panes;
  a.kind = 'remote';
  b.kind = 'remote';
  const save = (side: 'left' | 'right') =>
    buildMenus(h.ctx)
      .flatMap((menu) => menu.items)
      .find(
        (entry) =>
          entry.label ===
          i18n.t('menu.file.saveBookmarkSide', { side: i18n.t(`paneSide.${side}`) }),
      )!;
  // An empty connection form has nothing to save.
  assert.equal(save('left').disabled, true);
  assert.equal(save('right').disabled, true);
  a.status = 'connected';
  assert.equal(save('left').disabled, false);
  assert.equal(save('right').disabled, true);
  save('left').onClick!();
  applicationShortcuts(h.ctx)['save-site']();
  applicationShortcuts(h.ctx)['save-site-secondary']();
  assert.deepEqual(h.calls, [
    ['save', 'a'],
    ['save', 'a'],
  ]);
});
