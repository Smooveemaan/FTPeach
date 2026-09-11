import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMenus } from '../../../src/app/menus.ts';
import type { MenusContext } from '../../../src/app/menus.ts';
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
  const ctx: MenusContext = {
    modalOpen: false,
    openNewTab: record('new'),
    tabs: [tab],
    closeTab: record('close'),
    reopenClosedTab: record('reopen'),
    canReopenClosedTab: false,
    activeTabId: tab.id,
    freeConnectTargetPaneId: 'b',
    startPaneConnect: record('connect'),
    soleConnectedRemotePane: null,
    connectedRemotePanes: [],
    disconnectPane: record('disconnect'),
    handleSaveSite: (id) => () => record('save')(id),
    setShowExportSettings: record('export'),
    setShowImportSettings: record('import'),
    theme: 'dark',
    changeTheme: record('theme'),
    resetLayout: record('reset'),
    syncBrowsing: false,
    syncEligible: false,
    toggleSync: record('sync'),
    showHiddenFiles: false,
    toggleHiddenFiles: record('hidden'),
    showLocalPane: true,
    toggleLocalPane: record('local'),
    showRemotePane: true,
    toggleRemotePane: record('remote'),
    showTransferQueue: true,
    toggleTransferQueue: record('queue'),
    logEnabled: false,
    toggleLog: record('log'),
    effectivePaneOrientation: 'horizontal',
    windowNarrow: false,
    togglePaneOrientation: record('orientation'),
    refreshBothPanes: record('refreshBoth'),
    panes: tab.panes,
    canCopyBetween: () => true,
    copySelectedWithConfirm: (source, target, refreshSource, refreshTarget) => {
      record('copy')(source.id, target.id);
      refreshSource();
      refreshTarget();
    },
    hasCompletedTransfers: false,
    clearCompletedTransfers: record('clear'),
    refreshPane: record('refresh'),
    openSiteManager: record('sites'),
    openLocalPathManager: record('paths'),
    openSettings: record('settings'),
    openAbout: record('about'),
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
    'menu.view.lightTheme',
    'menu.edit.settings',
    'menu.help.about',
    'menu.help.checkUpdates',
  ])
    h.item(key).onClick!();
  h.item('menu.transfer.copySelectedRight').onClick!();
  h.item('menu.transfer.copySelectedLeft').onClick!();
  assert.deepEqual(h.calls.slice(0, 10), [
    ['new'],
    ['close', 'active'],
    ['reopen'],
    ['connect', 'b'],
    ['export', true],
    ['import', true],
    ['theme', 'light'],
    ['settings'],
    ['about'],
    ['updates'],
  ]);
  assert.deepEqual(h.calls.slice(10), [
    ['copy', 'a', 'b'],
    ['refresh', 'a', h.ctx.panes.a.path],
    ['refresh', 'b', h.ctx.panes.b.path],
    ['copy', 'b', 'a'],
    ['refresh', 'b', h.ctx.panes.b.path],
    ['refresh', 'a', h.ctx.panes.a.path],
  ]);
});

test('availability tracks modal, selection, connected panes and the last visible pane', () => {
  const h = harness();
  assert.equal(h.item('menu.file.closeTab').disabled, true);
  assert.equal(h.item('menu.file.disconnect').disabled, true);
  assert.equal(h.item('menu.transfer.copySelectedRight').disabled, true);
  h.ctx.panes.a.selected.add('file');
  assert.equal(h.item('menu.transfer.copySelectedRight').disabled, false);
  h.ctx.tabs.push(makeTab('second'));
  assert.equal(h.item('menu.file.closeTab').disabled, false);
  assert.equal(h.item('menu.file.reopenClosedTab').disabled, true);
  h.ctx.canReopenClosedTab = true;
  assert.equal(h.item('menu.file.reopenClosedTab').disabled, false);
  h.ctx.modalOpen = true;
  assert.equal(h.item('menu.file.newTab').disabled, true);
  assert.equal(h.item('menu.file.closeTab').disabled, true);
  assert.equal(h.item('menu.file.reopenClosedTab').disabled, true);
  h.ctx.showRemotePane = false;
  assert.equal(h.item('menu.view.leftPane').disabled, true);
  h.ctx.windowNarrow = true;
  assert.equal(h.item('menu.view.stackedPanes').disabled, true);
  h.ctx.soleConnectedRemotePane = h.ctx.panes.b;
  h.item('menu.file.disconnect').onClick!();
  assert.deepEqual(h.calls, [['disconnect', 'b']]);
});

test('shortcut overrides and unbinding propagate into menu labels', () => {
  const h = harness();
  h.ctx.keyboardShortcuts = { 'new-tab': 'Alt+KeyN', 'close-tab': '' };
  assert.equal(h.item('menu.file.newTab').shortcut, 'Alt+N');
  assert.equal(h.item('menu.file.closeTab').shortcut, '');
  assert.equal(h.item('menu.file.reopenClosedTab').shortcut, 'Ctrl+Shift+T');
});
