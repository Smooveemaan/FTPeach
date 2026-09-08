import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPaneConnectionModel } from '../../../src/features/file-browser/panes/paneConnectionModel.ts';
import { makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';

const translate = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}:${Object.values(values).join('|')}` : key;

test('pane connection model prioritizes connecting state and finds the available pane', () => {
  const tab = makeTab('first');
  tab.panes.a = {
    ...tab.panes.a,
    kind: 'remote',
    status: 'connecting',
    connectionId: 'pending',
  };
  tab.panes.b = { ...tab.panes.b, status: 'error' };

  const model = buildPaneConnectionModel({
    tabs: [tab],
    panes: tab.panes,
    paneOrientation: 'horizontal',
    translate,
  });

  assert.equal(model.aggregateStatus, 'connecting');
  assert.equal(model.freeConnectTargetPaneId, 'b');
  assert.deepEqual([...model.openConnectionIds], ['pending']);
});

test('pane connection model disambiguates duplicate labels by tab and pane side', () => {
  const first = makeTab('first');
  const second = makeTab('second');
  first.panes.b = {
    ...first.panes.b,
    status: 'connected',
    connectionId: 'connection-1',
    siteLabel: 'Shared server',
  };
  second.panes.a = {
    ...second.panes.a,
    kind: 'remote',
    status: 'connected',
    connectionId: 'connection-2',
    siteLabel: 'Shared server',
  };

  const model = buildPaneConnectionModel({
    tabs: [first, second],
    panes: first.panes,
    paneOrientation: 'vertical',
    translate,
  });

  assert.equal(
    model.connectionLabels.get('connection-1'),
    'paneSide.labelWithTab:Shared server|1|paneSide.bottom',
  );
  assert.equal(
    model.connectionLabels.get('connection-2'),
    'paneSide.labelWithTab:Shared server|2|paneSide.top',
  );
  assert.equal(model.soleConnectedRemotePane, first.panes.b);
});

test('pane connection model ignores disconnected panes with stale connection ids', () => {
  const tab = makeTab('first');
  tab.panes.b = {
    ...tab.panes.b,
    status: 'idle',
    connectionId: 'stale',
  };

  const model = buildPaneConnectionModel({
    tabs: [tab],
    panes: tab.panes,
    paneOrientation: 'horizontal',
    translate,
  });

  assert.equal(model.aggregateStatus, 'idle');
  assert.equal(model.openConnectionIds.size, 0);
  assert.equal(model.connectionLabels.size, 0);
  assert.equal(model.freeConnectTargetPaneId, 'b');
});
