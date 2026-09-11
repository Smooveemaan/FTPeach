import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApplicationWorkspaceModel } from '../../../src/app/applicationWorkspaceModel.ts';
import { makePane } from '../../../src/features/file-browser/panes/paneModel.ts';

test('workspace model derives status counters and section emptiness from domain state', () => {
  const left = makePane('a', 'local');
  left.entries = [
    { name: 'one.txt', isDirectory: false },
    { name: 'two.txt', isDirectory: false },
  ];
  left.selected = new Set(['one.txt']);

  const right = makePane('b', 'remote');
  right.entries = [{ name: 'docs', isDirectory: true }];

  const noop = () => undefined;
  const logLines = [{ id: 1, kind: 'info', ts: 1, connectionId: 'remote', line: 'connected' }];
  const model = buildApplicationWorkspaceModel({
    effectivePaneOrientation: 'horizontal',
    showLocalPane: true,
    showRemotePane: true,
    panesRef: { current: null },
    splitRatio: 0.5,
    resizing: false,
    startResize: noop,
    resetSplitRatio: noop,
    renderPane: () => null,
    dragMove: { startDrag: noop, cancelDrag: noop, ghostRef: { current: null }, dragInfo: null },
    transferLogLayout: {
      windowNarrow: false,
      showTransferQueue: true,
      logEnabled: true,
      resizingSection: null,
      startSectionResize: () => noop,
      resetSectionHeight: () => noop,
      transferLogRef: { current: null },
      transferQueueHeight: 160,
      logPanelHeight: 120,
      transferManuallyResized: false,
      logManuallyResized: false,
      transferLogSplitRatio: 0.5,
      resizingTransferLog: false,
      startTransferLogResize: noop,
      resetTransferLogSplitRatio: noop,
    },
    transfer: {
      empty: true,
      onRetry: noop,
      onPause: noop,
      onStop: noop,
      onClearCompleted: noop,
      connectionLabels: new Map(),
      columnWidths: {},
      onColumnWidthsChange: noop,
      columnOrder: [],
      onColumnOrderChange: noop,
    },
    log: {
      empty: false,
      lines: logLines,
      onClear: noop,
      activeConnectionIds: new Set(['remote']),
      connectionLabels: new Map([['remote', 'Server']]),
      showTimestamps: true,
      onToggleTimestamps: noop,
    },
    panes: { a: left, b: right },
    status: {
      status: 'connected',
      paneOrientation: 'horizontal',
      syncBrowsing: false,
      connectionVisualState: 'connected',
      hasActiveTransfers: false,
      activeTransfersCount: 0,
      hasPausedTransfers: false,
    },
  } as Parameters<typeof buildApplicationWorkspaceModel>[0]);

  assert.equal(model.transferLogSection.transfersEmpty, true);
  assert.equal(model.transferLogSection.logEmpty, false);
  assert.equal(model.transferLogSection.log.lines, logLines);
  assert.deepEqual(model.statusBar, {
    status: 'connected',
    paneOrientation: 'horizontal',
    syncBrowsing: false,
    connectionVisualState: 'connected',
    hasActiveTransfers: false,
    activeTransfersCount: 0,
    hasPausedTransfers: false,
    leftCount: 2,
    rightCount: 1,
    leftSelectedCount: 1,
    rightSelectedCount: 0,
    logLineCount: 1,
  });
});
