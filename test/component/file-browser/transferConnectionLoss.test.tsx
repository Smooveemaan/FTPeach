import { renderHook } from '@testing-library/react';
import type { SetStateAction } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
vi.mock('../../../src/platform/api/index.ts', () => ({
  api: { transfer: { onProgress: vi.fn() } },
}));
import { api } from '../../../src/platform/api/index.ts';
import type { TransferProgress } from '../../../src/platform/ipcContracts.ts';
import type { TabState } from '../../../src/features/file-browser/panes/paneModel.ts';
import { makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';
import { useTransferConnectionLoss } from '../../../src/features/file-browser/panes/usePaneRuntimeEffects.ts';
import type { TransferStatus } from '../../../src/features/transfers/transferStore.ts';
import {
  resetTransfersStoreForTests,
  setTransfersStore,
} from '../../../src/features/transfers/transferStore.ts';

afterEach(() => {
  resetTransfersStoreForTests();
});

test.each([
  ['progress', true],
  ['cancelling', false],
  ['stopped', false],
  ['paused', false],
] as const satisfies ReadonlyArray<readonly [TransferStatus, boolean]>)(
  'a connection a %s transfer reports lost marks the pane: %s',
  (status, marked) => {
    let progress: ((_payload: TransferProgress) => void) | undefined;
    vi.spyOn(api.transfer, 'onProgress').mockImplementation((callback) => {
      progress = callback;
      return () => {};
    });
    setTransfersStore({
      upload: {
        id: 'upload',
        name: 'text.txt',
        status,
        bytes: 0,
        startedAt: 0,
        direction: 'up',
        protocol: 'ftp',
        connectionId: 'session',
        localFile: 'C:\\text.txt',
        remoteTarget: '/text.txt',
      },
    });
    const tab = makeTab('tab');
    tab.panes.b.kind = 'remote';
    tab.panes.b.connectionId = 'session';
    tab.panes.b.status = 'connected';
    let tabs: TabState[] = [tab];
    const setTabs = (update: SetStateAction<TabState[]>) => {
      tabs = typeof update === 'function' ? update(tabs) : update;
    };
    renderHook(() => useTransferConnectionLoss(setTabs, 'The connection was lost.'));

    expect(progress).toBeDefined();
    // What a stopped FTP transfer reports as its pool lets the connection go.
    progress?.({
      id: 'upload',
      connectionId: 'session',
      status: 'error',
      errorCode: 'connectionLost',
      error: 'Connection closed',
    });
    expect(tabs[0]?.panes.b.status).toBe(marked ? 'error' : 'connected');
  },
);
