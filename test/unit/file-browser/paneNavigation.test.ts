import assert from 'node:assert/strict';
import test from 'node:test';
import { createPaneNavigation } from '../../../src/features/file-browser/panes/createPaneNavigation.ts';
import { makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';

function fixture() {
  const tab = makeTab('tab');
  tab.panes.a.path = 'C:\\current';
  tab.panes.a.history = ['C:\\previous'];
  tab.panes.a.future = ['C:\\next'];
  const requests: {
    path: string;
    resolve: (_result: { ok: boolean; path?: string } | void) => void;
  }[] = [];
  const navigation = createPaneNavigation({
    panes: tab.panes,
    activeTabId: tab.id,
    syncBrowsing: false,
    setTabs: () => {},
    syncAnchorsRef: { current: {} },
    inFlightRefreshesRef: { current: {} },
    pendingDescendRef: { current: {} },
    refreshPane: (_id, path) =>
      new Promise((resolve) => {
        requests.push({ path, resolve });
      }),
    updatePane: (id, patch) => {
      Object.assign(tab.panes[id], typeof patch === 'function' ? patch(tab.panes[id]) : patch);
    },
  });
  return { navigation, requests, pane: tab.panes.a };
}

test('failed back and forward listings leave path and both history stacks intact', async () => {
  for (const direction of ['goPaneBack', 'goPaneForward'] as const) {
    const { navigation, requests, pane } = fixture();
    navigation[direction]('a');
    assert.deepEqual(pane.history, ['C:\\previous']);
    assert.deepEqual(pane.future, ['C:\\next']);
    requests[0]!.resolve({ ok: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pane.path, 'C:\\current');
    assert.deepEqual(pane.history, ['C:\\previous']);
    assert.deepEqual(pane.future, ['C:\\next']);
  }
});

test('rapid duplicate back requests consume the history entry only once', async () => {
  const { navigation, requests, pane } = fixture();
  navigation.goPaneBack('a');
  navigation.goPaneBack('a');
  pane.path = 'C:\\previous';
  for (const request of requests) request.resolve({ ok: true, path: request.path });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(pane.history, []);
  assert.deepEqual(pane.future, ['C:\\current', 'C:\\next']);
});

test('a superseded history navigation does not commit its stacks', async () => {
  const { navigation, requests, pane } = fixture();
  navigation.goPaneBack('a');
  navigation.goPaneForward('a');
  requests[0]!.resolve();
  pane.path = 'C:\\next';
  requests[1]!.resolve({ ok: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(pane.history, ['C:\\previous', 'C:\\current']);
  assert.deepEqual(pane.future, []);
});

test('successful ordinary navigation records the previous path and clears forward history', async () => {
  const { navigation, requests, pane } = fixture();
  const pending = navigation.navigatePane('a', 'C:\\new');
  requests[0]!.resolve({ ok: true, path: 'C:\\new' });
  await pending;
  assert.deepEqual(pane.history, ['C:\\previous', 'C:\\current']);
  assert.deepEqual(pane.future, []);
});

test('empty history is a no-op and refresh skips a disconnected remote pane', () => {
  const { navigation, requests, pane } = fixture();
  pane.history = [];
  pane.future = [];
  navigation.goPaneBack('a');
  navigation.goPaneForward('a');
  assert.equal(requests.length, 0);
  navigation.refreshBothPanes();
  assert.deepEqual(
    requests.map((request) => request.path),
    ['C:\\current'],
  );
  requests[0]!.resolve({ ok: true });
});
