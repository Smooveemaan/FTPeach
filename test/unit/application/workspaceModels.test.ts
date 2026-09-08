import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTab, otherPaneId } from '../../../src/features/file-browser/panes/paneModel.ts';
import { computeTransferSummary } from '../../../src/features/transfers/useTransferSummary.ts';
import type { TransferRow } from '../../../src/features/transfers/transferStore.ts';
import {
  initialSectionResizeState,
  sectionResizeReducer,
} from '../../../src/app/layout/sectionResizeReducer.ts';

function transfer(overrides: Partial<TransferRow>): TransferRow {
  const row = {
    id: 'transfer',
    direction: 'down' as const,
    name: 'file.txt',
    protocol: 'ftp' as const,
    status: 'progress' as const,
    bytes: 0,
    startedAt: 0,
    connectionId: 'connection',
    sourceConnectionId: 'source',
    targetConnectionId: 'target',
    localFile: 'C:\\file.txt',
    remoteFile: '/file.txt',
    localTarget: 'C:\\file.txt',
    remoteTarget: '/file.txt',
    sourcePath: '/file.txt',
    ...overrides,
  };
  if (row.direction === 'copy') return { ...row, direction: 'copy', dragOut: false };
  if (row.direction === 'up') return { ...row, direction: 'up', dragOut: false };
  return { ...row, direction: 'down' };
}

test('pane model creates independent local and remote pane state', () => {
  const tab = makeTab('tab-1');
  assert.equal(tab.panes.a.kind, 'local');
  assert.equal(tab.panes.b.kind, 'remote');
  assert.notEqual(tab.panes.a.selected, tab.panes.b.selected);
  assert.equal(otherPaneId('a'), 'b');
});

test('transfer summary ignores byte-only detail and exposes command capabilities', () => {
  const summary = computeTransferSummary({
    upload: transfer({ id: 'upload', status: 'progress', direction: 'up', protocol: 'webdav' }),
    download: transfer({
      id: 'download',
      status: 'paused',
      direction: 'down',
      protocol: 'sftp',
      bytes: 20,
    }),
    failed: transfer({ id: 'failed', status: 'error' }),
  });
  assert.equal(summary.hasActiveTransfers, true);
  assert.equal(summary.hasPausableTransfers, false);
  assert.equal(summary.hasPausedTransfers, true);
  assert.equal(summary.hasRetryableTransfers, true);
});

test('section resize reducer keeps one active gesture and durable touched flags', () => {
  const started = sectionResizeReducer(initialSectionResizeState, {
    type: 'start',
    section: 'transfers',
  });
  const touched = sectionResizeReducer(started, { type: 'touch', section: 'transfers' });
  const stopped = sectionResizeReducer(touched, { type: 'stop' });
  assert.equal(stopped.activeSection, null);
  assert.equal(stopped.transferManuallyResized, true);
  assert.equal(stopped.logManuallyResized, false);
});
