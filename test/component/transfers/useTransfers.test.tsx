import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { act, renderHook } from '@testing-library/react';
import {
  getTransfersSnapshot,
  setTransfersStore,
  useTransfers,
} from '../../../src/features/transfers/index.ts';
import { resetTransfersStoreForTests } from '../../../src/features/transfers/transferStore.ts';
import { tauriApi } from '../../../src/platform/tauriApi.ts';
import type {
  CommandResult,
  DragOutTransferStarted,
  TransferProgress,
} from '../../../src/platform/ipcContracts.ts';
import type { SiteProtocol } from '../../../src/shared/types.ts';
import type { RecursiveIntent } from '../../../src/platform/api/transfers.ts';
import type {
  TransferRow,
  TransferState,
  TransferStoreUpdater,
} from '../../../src/features/transfers/transferStore.ts';

type TransfersApi = ReturnType<typeof useTransfers>;

beforeEach(() => {
  // Retry isolation depends on distinct attempt IDs, unlike the shared UI fixture.
  vi.spyOn(crypto, 'randomUUID').mockImplementation(randomUUID);
});

const folderEntry = { name: 'folder', isDirectory: true, size: 0 };
function localFolderMove(): Parameters<TransfersApi['copyEntries']>[0] {
  return {
    sourcePane: {
      kind: 'local',
      status: 'connected',
      connectionId: null,
      protocol: null,
      path: 'C:\\source',
      entries: [folderEntry],
    },
    targetPane: {
      kind: 'local',
      status: 'connected',
      connectionId: null,
      protocol: null,
      path: 'C:\\target',
      entries: [],
    },
    names: ['folder'],
    move: true,
  };
}

test('recursive failures preserve backend diagnostics without renderer deletion', async () => {
  for (const reason of [
    'Access denied',
    'Depth budget exceeded',
    'Nested mkdir denied',
    'Destination is inside source',
  ]) {
    await withHarness(async ({ getApi, mockApi, calls, errors, getSnapshot }) => {
      mockApi.transfer.recursive = async (intent) => {
        assert.equal(intent.moving, true);
        assert.equal(intent.source.kind, 'local');
        return {
          ok: false,
          outcome: 'failed',
          scanned: 0,
          completed: 0,
          errors: [{ message: intent.source.path + ': ' + reason }],
        };
      };
      await act(async () => {
        await getApi().copyEntries(localFolderMove());
      });
      assert.equal(calls.fsLocalDelete.length, 0);
      assert.equal(errors.length, 1);
      assert.ok(errors[0]!.includes(reason));
      assert.equal(Object.values(getSnapshot())[0]?.status, 'error');
    });
  }
});

test('a successful empty-folder move is completed entirely by the backend', async () => {
  await withHarness(async ({ getApi, mockApi, calls, errors, getSnapshot }) => {
    mockApi.transfer.recursive = async () => ({
      ok: true,
      outcome: 'complete',
      scanned: 1,
      completed: 0,
      errors: [],
    });
    mockApi.fsLocal.mkdir = async () => {
      throw new Error('renderer must not create manifest directories');
    };
    await act(async () => {
      await getApi().copyEntries(localFolderMove());
    });
    assert.equal(calls.fsLocalDelete.length, 0);
    assert.deepEqual(errors, []);
    assert.equal(Object.values(getSnapshot())[0]?.status, 'done');
  });
});

test('a rejected recursive IPC settles its row instead of leaving progress active', async () => {
  await withHarness(async ({ getApi, mockApi, getSnapshot }) => {
    mockApi.transfer.recursive = async () => {
      throw new Error('IPC unavailable');
    };
    await act(async () => {
      await getApi().copyEntries(localFolderMove());
    });
    const row = Object.values(getSnapshot())[0]!;
    assert.equal(row.status, 'error');
    assert.match(row.errorMessage!, /IPC unavailable/);
  });
});

test('folder upload, download and relay submit endpoint intent without per-file IPC', async () => {
  for (const direction of ['upload', 'download', 'relay']) {
    await withHarness(async ({ getApi, mockApi, calls, errors }) => {
      let submitted = false;
      mockApi.transfer.recursive = async (intent) => {
        submitted = true;
        assert.equal(intent.source.kind, direction === 'upload' ? 'local' : 'remote');
        assert.equal(intent.target.kind, direction === 'download' ? 'local' : 'remote');
        return {
          ok: false,
          outcome: 'partial',
          scanned: 5,
          completed: 1,
          errors: [{ message: 'folder: Nested mkdir denied' }],
        };
      };
      const options = localFolderMove();
      if (direction !== 'upload')
        options.sourcePane = {
          ...options.sourcePane,
          kind: 'remote',
          connectionId: 'source',
          protocol: 'sftp',
          path: '/source',
        };
      if (direction !== 'download')
        options.targetPane = {
          ...options.targetPane,
          kind: 'remote',
          connectionId: 'target',
          protocol: 'sftp',
          path: '/target',
        };
      await act(async () => {
        await getApi().copyEntries(options);
      });
      assert.ok(submitted);
      assert.equal(calls.fsLocalDelete.length + calls.sessionDelete.length, 0);
      assert.equal(calls.upload.length + calls.download.length, 0);
      assert.match(errors[0]!, /Nested mkdir denied/);
    });
  }
});

test('recursive cancellation waits for the backend report and rejects immediate retry', async () => {
  await withHarness(async ({ getApi, mockApi, getSnapshot }) => {
    const pending = createDeferred<Awaited<ReturnType<typeof mockApi.transfer.recursive>>>();
    let cancelled = '';
    mockApi.transfer.recursive = () => pending.promise;
    mockApi.transfer.cancelRecursive = async (id) => {
      cancelled = id;
    };
    let running: Promise<void>;
    await act(async () => {
      running = getApi().copyEntries(localFolderMove());
      await Promise.resolve();
    });
    const row = Object.values(getSnapshot())[0]!;
    await act(async () => {
      await getApi().stopTransfer(row.id);
      await getApi().retryTransfer(row.id);
    });
    assert.equal(cancelled, row.attemptId);
    assert.equal(getSnapshot()[row.id]?.status, 'cancelling');
    await act(async () => {
      pending.resolve({ ok: false, outcome: 'partial', scanned: 1, completed: 0, errors: [] });
      await running;
    });
    assert.equal(getSnapshot()[row.id]?.status, 'stopped');
  });
});

test('stopping queued and active uploads never requests deletion of the destination', async () => {
  for (const active of [false, true]) {
    await withHarness(async ({ getApi, getSnapshot, mockApi, calls, emitProgress }) => {
      const { id, runPromise } = await startStuckUpload(getApi, getSnapshot);
      if (active)
        act(() =>
          emitProgress({
            id: getSnapshot()[id]!.attemptId!,
            connectionId: 'c1',
            status: 'progress',
            bytes: 1,
            total: 10,
          }),
        );
      assert.equal(getSnapshot()[id]?.status, active ? 'progress' : 'queued');
      await act(async () => {
        await getApi().stopTransfer(id);
      });
      mockApi._nextUpload.resolve({ ok: false, errorCode: 'cancelled' });
      await act(async () => {
        await runPromise;
      });
      assert.equal(calls.sessionDelete.length, 0);
    });
  }
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (_value: T | PromiseLike<T>) => void;
}

interface UploadCall {
  connectionId: string;
  id: string;
  localFile: string;
  remoteTarget: string;
  resume: boolean;
}
interface DownloadCall {
  connectionId: string;
  id: string;
  remoteFile: string;
  localTarget: string;
  resume: boolean;
}
interface MockCalls {
  upload: UploadCall[];
  download: DownloadCall[];
  cancel: Array<{ connectionId: string; id: string; intent: 'pause' | 'stop' }>;
  sessionDelete: Array<{ connectionId: string; path: string; isDir: boolean }>;
  fsLocalDelete: Array<{ path: string }>;
  notifyTransfersComplete: Array<
    Parameters<Window['api']['notifications']['transfersComplete']>[0]
  >;
}
interface MockApi {
  _nextUpload: Deferred<CommandResult>;
  _nextDownload: Deferred<CommandResult>;
  transfer: Window['api']['transfer'];
  session: Window['api']['session'];
  fsLocal: Window['api']['fsLocal'];
  notifications: Window['api']['notifications'];
}
interface HarnessContext {
  getApi: () => TransfersApi;
  getSnapshot: () => TransferState;
  setSnapshot: (_updater: TransferStoreUpdater) => void;
  mockApi: MockApi;
  calls: MockCalls;
  errors: string[];
  emitProgress: (_payload: TransferProgress) => void;
  emitDragOutStarted: (_payload: DragOutTransferStarted) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function resolvedDeferred<T>(value: T): Deferred<T> {
  const deferred = createDeferred<T>();
  deferred.resolve(value);
  return deferred;
}

/** Restates the row the caller just put in the store, so the spread below has one. */
function withStatus(row: TransferRow | undefined, status: TransferRow['status']): TransferRow {
  if (!row) throw new Error('expected the transfer row to be in the store');
  return { ...row, status };
}

function makeTransferRow(
  overrides: Partial<TransferRow> & Pick<TransferRow, 'id' | 'direction' | 'name' | 'status'>,
): TransferRow {
  const row = {
    bytes: 0,
    startedAt: 1,
    connectionId: '',
    sourceConnectionId: '',
    targetConnectionId: '',
    localFile: '',
    remoteFile: '',
    localTarget: '',
    remoteTarget: '',
    sourcePath: '',
    protocol: 'ftp' as const,
    ...overrides,
  };
  if (row.direction === 'copy') return { ...row, direction: 'copy', dragOut: false };
  if (row.direction === 'up') return { ...row, direction: 'up', dragOut: false };
  return { ...row, direction: 'down' };
}

function makeMockApi() {
  const calls: MockCalls = {
    upload: [],
    download: [],
    cancel: [],
    sessionDelete: [],
    fsLocalDelete: [],
    notifyTransfersComplete: [],
  };
  let progressListener: ((_payload: TransferProgress) => void) | null = null;
  let dragOutListener: ((_payload: DragOutTransferStarted) => void) | null = null;
  const api: MockApi = {
    _nextUpload: createDeferred<CommandResult>(),
    _nextDownload: createDeferred<CommandResult>(),
    transfer: {
      ...tauriApi.transfer,
      onProgress: (cb: (_payload: TransferProgress) => void) => {
        progressListener = cb;
        return () => {
          progressListener = null;
        };
      },
      onDragOutStarted: (cb: (_payload: DragOutTransferStarted) => void) => {
        dragOutListener = cb;
        return () => {
          dragOutListener = null;
        };
      },
      upload: (connectionId, id, localFile, remoteTarget, resume) => {
        calls.upload.push({ connectionId, id, localFile, remoteTarget, resume });
        return api._nextUpload.promise;
      },
      download: (connectionId, id, remoteFile, localTarget, resume) => {
        calls.download.push({ connectionId, id, remoteFile, localTarget, resume });
        return api._nextDownload.promise;
      },
      cancel: (connectionId, id, intent) => {
        calls.cancel.push({ connectionId, id, intent });
        return Promise.resolve({ ok: true });
      },
    },
    session: {
      ...tauriApi.session,
      list: async () => ({ ok: true, entries: [] }),
      delete: (connectionId, path, isDir) => {
        calls.sessionDelete.push({ connectionId, path, isDir });
        return Promise.resolve({ ok: true });
      },
    },
    fsLocal: {
      ...tauriApi.fsLocal,
      list: async (path = '') => ({ ok: true, path, entries: [] }),
      delete: (path) => {
        calls.fsLocalDelete.push({ path });
        return Promise.resolve({ ok: true });
      },
    },
    notifications: {
      ...tauriApi.notifications,
      transfersComplete: (summary) => {
        calls.notifyTransfersComplete.push(summary);
        return Promise.resolve();
      },
    },
  };
  return {
    api,
    calls,
    emitProgress: (payload: TransferProgress) => progressListener?.(payload),
    emitDragOutStarted: (payload: DragOutTransferStarted) => dragOutListener?.(payload),
  };
}

async function withHarness(
  fn: (_context: HarnessContext) => Promise<void>,
  options: Partial<Parameters<typeof useTransfers>[0]> = {},
) {
  // A full reset, not just an empty state: dead-connection marks and the
  // attempt/target indexes are module state too, and 'c1'-style fixture ids
  // get reused across tests in this file, unlike real connection ids.
  resetTransfersStoreForTests();
  const { api: mockApi, calls, emitProgress, emitDragOutStarted } = makeMockApi();
  const previousApi = window.api;
  window.api = {
    ...tauriApi,
    transfer: mockApi.transfer,
    session: mockApi.session,
    fsLocal: mockApi.fsLocal,
    notifications: mockApi.notifications,
  };

  const errors: string[] = [];
  const { result, unmount } = renderHook(() =>
    useTransfers({
      ...options,
      setErrorMessage: (message) => {
        if (message) errors.push(message);
      },
    }),
  );

  try {
    await fn({
      getApi: () => result.current,
      getSnapshot: getTransfersSnapshot,
      setSnapshot: (updater) => {
        act(() => setTransfersStore(updater));
      },
      mockApi,
      calls,
      errors,
      emitProgress,
      emitDragOutStarted,
    });
  } finally {
    unmount();
    setTransfersStore(() => ({}));
    window.api = previousApi;
  }
}

test('pause rejects immediate retry and late events cannot overwrite a newer attempt', async () => {
  await withHarness(async ({ getApi, getSnapshot, calls, mockApi, emitProgress }) => {
    const { id, runPromise } = await startStuckUpload(getApi, getSnapshot);
    const oldAttempt = calls.upload[0]!.id;
    await act(async () => {
      await getApi().pauseTransfer(id);
      await getApi().retryTransfer(id);
    });
    assert.equal(calls.upload.length, 1);
    assert.equal(getSnapshot()[id]!.status, 'cancelling');
    await act(async () => {
      mockApi._nextUpload.resolve({ ok: false, errorCode: 'cancelled' });
      await runPromise;
    });
    mockApi._nextUpload = createDeferred<CommandResult>();
    let retry!: Promise<void>;
    await act(async () => {
      retry = getApi().retryTransfer(id);
      await Promise.resolve();
    });
    const newAttempt = calls.upload.at(-1)!.id;
    assert.notEqual(newAttempt, oldAttempt);
    await act(async () => {
      await getApi().retryTransfer(id);
    });
    assert.equal(calls.upload.length, 2);
    act(() => {
      emitProgress({ id: oldAttempt, connectionId: 'c1', status: 'error', bytes: 999 });
    });
    assert.equal(getSnapshot()[id]!.bytes, 0);
    assert.equal(getSnapshot()[id]!.status, 'queued');
    await act(async () => {
      mockApi._nextUpload.resolve({ ok: true });
      await retry;
    });
    assert.equal(getSnapshot()[id]!.status, 'done');
  });
});

test('declining an existing recursive destination never submits a destructive operation', async () => {
  for (const policy of ['skip', 'ask'] as const) {
    const prompts: string[] = [];
    await withHarness(
      async ({ getApi, mockApi, calls }) => {
        let copies = 0;
        let recursiveCalls = 0;
        mockApi.transfer.recursive = async (intent) => {
          recursiveCalls++;
          assert.equal(policy, 'skip');
          assert.equal(intent.skipExisting, true);
          assert.equal(intent.overwrite, false);
          return {
            ok: false,
            outcome: 'failed',
            scanned: 1,
            completed: 0,
            errors: [{ message: 'Destination folder is occupied by a file' }],
          };
        };
        mockApi.fsLocal.validateCopy = async () => ({ ok: true });
        mockApi.fsLocal.mkdir = async () => ({ ok: true });
        mockApi.fsLocal.copyFile = async () => {
          copies++;
          return { ok: true };
        };
        mockApi.fsLocal.list = async (path = '') => ({
          ok: true,
          path,
          entries: [
            {
              name: 'FOLDER',
              isDirectory: false,
              size: 1,
            },
          ],
        });
        await act(async () => {
          await getApi().copyEntries(localFolderMove());
        });
        assert.equal(copies, 0);
        assert.equal(recursiveCalls, policy === 'skip' ? 1 : 0);
        assert.equal(calls.fsLocalDelete.length, 0);
        assert.equal(prompts.length, policy === 'ask' ? 1 : 0);
      },
      {
        overwriteAction: policy,
        confirmOverwrite: async (path) => {
          prompts.push(path);
          return false;
        },
      },
    );
  }
});

const localDropTarget: Parameters<TransfersApi['handleOsDropFiles']>[0] = {
  kind: 'local',
  status: 'connected',
  connectionId: null,
  protocol: null,
  path: 'C:\\target',
  entries: [],
};

test('an OS drop onto a local pane is copied there without a session', async () => {
  await withHarness(async ({ getApi, mockApi, errors }) => {
    const copies: string[][] = [];
    const intents: RecursiveIntent[] = [];
    mockApi.fsLocal.validateCopy = async () => ({ ok: true });
    mockApi.fsLocal.copyFile = async (source, destination) => {
      copies.push([source, destination]);
      return { ok: true };
    };
    mockApi.transfer.recursive = async (intent) => {
      intents.push(intent);
      return { ok: true, outcome: 'complete', scanned: 1, completed: 1, errors: [] };
    };
    await act(async () => {
      await getApi().handleOsDropFiles(localDropTarget, [
        { path: 'D:\\drop\\file.txt', name: 'file.txt', isDirectory: false },
        { path: 'D:\\drop\\folder', name: 'folder', isDirectory: true },
      ]);
    });
    assert.deepEqual(copies, [['D:\\drop\\file.txt', 'C:\\target\\file.txt']]);
    assert.equal(intents.length, 1);
    assert.deepEqual(intents[0]?.source, { kind: 'local', path: 'D:\\drop\\folder' });
    assert.deepEqual(intents[0]?.target, { kind: 'local', path: 'C:\\target\\folder' });
    assert.deepEqual(errors, []);
  });
});

test('a destination the caller already approved is not asked about a second time', async () => {
  for (const approvedAlready of [false, true]) {
    const prompts: string[] = [];
    await withHarness(
      async ({ getApi, mockApi, calls }) => {
        mockApi.session.list = async () => ({
          ok: true,
          entries: [{ name: 'file.bin', isDirectory: false, size: 1 }],
        });
        mockApi._nextUpload.resolve({ ok: true });
        await act(async () => {
          await getApi().handleOsDropFiles(
            {
              kind: 'remote',
              status: 'connected',
              connectionId: 'c1',
              protocol: 'sftp',
              path: '/upload',
              entries: [],
            },
            [{ path: 'D:\\drop\\file.bin', name: 'file.bin', isDirectory: false }],
            null,
            undefined,
            approvedAlready,
          );
        });
        // Without the answer carried down, the pane's own "overwrite it?"
        // dialog is followed by this one about the same file.
        assert.deepEqual(prompts, approvedAlready ? [] : ['/upload/file.bin']);
        assert.equal(calls.upload.length, 1);
      },
      {
        overwriteAction: 'ask',
        confirmOverwrite: async (path) => {
          prompts.push(path);
          return true;
        },
      },
    );
  }
});

async function startStuckUpload(
  getApi: () => TransfersApi,
  getSnapshot: () => TransferState,
  connectionId = 'c1',
  protocol: SiteProtocol = 'ftp',
) {
  const before = new Set(Object.keys(getSnapshot()));
  let runPromise!: ReturnType<TransfersApi['runUpload']>;
  await act(async () => {
    runPromise = getApi().runUpload(
      connectionId,
      protocol,
      'C:\\local\\file.bin',
      'file.bin',
      '/remote/dir',
    );
    await Promise.resolve();
  });
  const id = Object.keys(getSnapshot()).find((k) => !before.has(k));
  if (!id) throw new Error('Upload row was not created');
  return { id, runPromise };
}

test('new transfer ids never overwrite an existing queue row', async () => {
  await withHarness(async ({ getApi, getSnapshot, setSnapshot, mockApi, emitProgress }) => {
    const first = await startStuckUpload(getApi, getSnapshot);
    mockApi._nextUpload.resolve({ ok: true });
    await act(async () => {
      await first.runPromise;
    });
    // The command result completes the row; a final event can still update
    // its byte count before the next transfer starts.
    act(() => {
      emitProgress({
        id: getSnapshot()[first.id]!.attemptId!,
        connectionId: 'c1',
        status: 'done',
        bytes: 1,
        total: 1,
      });
    });
    assert.equal(getSnapshot()[first.id]?.bytes, 1);

    const sequence = Number(first.id.slice(1));
    assert.ok(Number.isInteger(sequence));
    const occupiedId = `t${sequence + 1}`;
    const occupied = makeTransferRow({
      id: occupiedId,
      direction: 'down',
      name: 'existing.bin',
      status: 'paused',
    });
    setSnapshot((previous) => ({ ...previous, [occupiedId]: occupied }));
    mockApi._nextUpload = createDeferred<CommandResult>();

    const second = await startStuckUpload(getApi, getSnapshot);
    assert.notEqual(second.id, occupiedId);
    assert.equal(getSnapshot()[occupiedId], occupied);

    mockApi._nextUpload.resolve({ ok: true });
    await act(async () => {
      await second.runPromise;
    });
  });
});

test('pause then stop on an upload never deletes its remote destination', async () => {
  await withHarness(async ({ getApi, getSnapshot, mockApi, calls }) => {
    const { id, runPromise } = await startStuckUpload(getApi, getSnapshot);
    assert.equal(getSnapshot()[id]?.status, 'queued');

    await act(async () => {
      await getApi().pauseTransfer(id);
    });
    assert.equal(getSnapshot()[id]?.status, 'cancelling');
    assert.equal(calls.cancel.length, 1, 'pausing a running transfer sends one transfer:cancel');

    await act(async () => {
      await getApi().stopTransfer(id);
    });
    assert.equal(getSnapshot()[id]?.status, 'cancelling');
    assert.equal(calls.cancel.length, 1, 'stop-after-pause must not send a second cancel');
    assert.equal(calls.sessionDelete.length, 0);

    mockApi._nextUpload.resolve({ ok: false, error: 'Connection closed' });
    await act(async () => {
      await runPromise;
    });
    assert.equal(getSnapshot()[id]?.status, 'stopped');
    assert.equal(calls.sessionDelete.length, 0);
  });
});

test('a real (non-user-initiated) transfer failure reports the error and marks the row', async () => {
  await withHarness(async ({ getApi, mockApi, calls, errors, getSnapshot }) => {
    mockApi._nextDownload.resolve({ ok: false, error: 'ECONNRESET' });
    let resPromise!: ReturnType<TransfersApi['runDownload']>;
    await act(async () => {
      resPromise = getApi().runDownload('c1', 'ftp', '/remote/file.bin', 'file.bin', 'C:\\local');
      await resPromise;
    });
    const res = await resPromise;
    assert.equal(res.ok, false);
    assert.equal(calls.download[0]?.resume, true, 'a durable partial is resumed automatically');
    assert.deepEqual(errors, ['ECONNRESET']);
    const [id] = Object.keys(getSnapshot());
    assert.ok(id);
    assert.equal(getSnapshot()[id]?.status, 'error');
    assert.equal(
      calls.fsLocalDelete.length,
      0,
      'no cleanup for a plain error, only for an explicit Stop',
    );
  });
});

test('dropping the same paused download resumes its queue row instead of creating a duplicate', async () => {
  await withHarness(async ({ getApi, getSnapshot, setSnapshot, mockApi, calls }) => {
    setSnapshot(() => ({
      pausedDownload: makeTransferRow({
        id: 'pausedDownload',
        direction: 'down',
        protocol: 'webdav',
        name: 'file.bin',
        bytes: 300,
        total: 1000,
        status: 'paused',
        connectionId: 'dav1',
        remoteFile: '/remote/file.bin',
        localTarget: 'C:\\local\\file.bin',
        startedAt: 1,
      }),
    }));
    mockApi._nextDownload.resolve({ ok: true });

    await act(async () => {
      await getApi().runDownload('dav1', 'webdav', '/remote/file.bin', 'file.bin', 'C:\\local');
    });

    assert.deepEqual(Object.keys(getSnapshot()), ['pausedDownload']);
    assert.equal(calls.download.length, 1);
    assert.equal(calls.download[0]?.id, getSnapshot().pausedDownload?.attemptId);
    assert.notEqual(calls.download[0]?.id, 'pausedDownload');
    assert.equal(calls.download[0]?.resume, true);
  });
});

test('re-dropping a failed upload reuses its row but starts a new staged upload', async () => {
  await withHarness(async ({ getApi, getSnapshot, setSnapshot, mockApi, calls }) => {
    setSnapshot(() => ({
      erroredUpload: makeTransferRow({
        id: 'erroredUpload',
        direction: 'up',
        protocol: 'sftp',
        name: 'music.mp3',
        bytes: 400,
        total: 1000,
        status: 'error',
        errorCode: 'connectionLost',
        connectionId: 'c1',
        localFile: 'C:\\local\\music.mp3',
        remoteTarget: '/remote/music.mp3',
        startedAt: 1,
      }),
    }));
    mockApi._nextUpload.resolve({ ok: true });

    await act(async () => {
      await getApi().runUpload('c1', 'sftp', 'C:\\local\\music.mp3', 'music.mp3', '/remote');
    });

    assert.deepEqual(Object.keys(getSnapshot()), ['erroredUpload']);
    assert.equal(calls.upload.length, 1);
    assert.equal(calls.upload[0]?.id, getSnapshot().erroredUpload?.attemptId);
    assert.notEqual(calls.upload[0]?.id, 'erroredUpload');
    assert.equal(
      calls.upload[0]?.resume,
      false,
      'a new attempt must never append to an unowned remote file',
    );
  });
});

test('dropping an upload that is already running does not start a second writer', async () => {
  await withHarness(async ({ getApi, setSnapshot, calls }) => {
    setSnapshot(() => ({
      activeUpload: makeTransferRow({
        id: 'activeUpload',
        direction: 'up',
        protocol: 'sftp',
        name: 'music.mp3',
        status: 'progress',
        connectionId: 'c1',
        localFile: 'C:\\local\\music.mp3',
        remoteTarget: '/remote/music.mp3',
        startedAt: 1,
      }),
    }));

    let resultPromise!: ReturnType<TransfersApi['runUpload']>;
    await act(async () => {
      resultPromise = getApi().runUpload(
        'c1',
        'sftp',
        'C:\\local\\music.mp3',
        'music.mp3',
        '/remote',
      );
      await resultPromise;
    });
    const result = await resultPromise;

    assert.ok(result);
    assert.equal('alreadyRunning' in result && result.alreadyRunning, true);
    assert.equal(calls.upload.length, 0);
  });
});

test('dropping a download that is already running does not start a second writer', async () => {
  await withHarness(async ({ getApi, setSnapshot, calls }) => {
    setSnapshot(() => ({
      activeDownload: makeTransferRow({
        id: 'activeDownload',
        direction: 'down',
        protocol: 'webdav',
        name: 'file.bin',
        status: 'progress',
        connectionId: 'dav1',
        remoteFile: '/remote/file.bin',
        localTarget: 'C:\\local\\file.bin',
        startedAt: 1,
      }),
    }));

    let resultPromise!: ReturnType<TransfersApi['runDownload']>;
    await act(async () => {
      resultPromise = getApi().runDownload(
        'dav1',
        'webdav',
        '/remote/file.bin',
        'file.bin',
        'C:\\local',
      );
      await resultPromise;
    });
    const result = await resultPromise;

    assert.ok(result);
    assert.equal('alreadyRunning' in result && result.alreadyRunning, true);
    assert.equal(calls.download.length, 0);
  });
});

test('retryTransfer resumes paused uploads and downloads, but restarts stopped ones', async () => {
  await withHarness(async ({ getApi, getSnapshot, setSnapshot, mockApi, calls }) => {
    setSnapshot(() => ({
      pausedRow: makeTransferRow({
        id: 'pausedRow',
        direction: 'up',
        protocol: 'ftp',
        name: 'x',
        bytes: 500,
        total: 1000,
        status: 'paused',
        connectionId: 'c1',
        localFile: 'L',
        remoteTarget: 'R',
        startedAt: 1,
      }),
    }));
    mockApi._nextUpload = resolvedDeferred<CommandResult>({ ok: true });

    await act(async () => {
      await getApi().retryTransfer('pausedRow', () => {});
    });
    assert.equal(calls.upload.at(-1)?.resume, true, 'FTP appends to the staging a pause kept');
    assert.equal(getSnapshot().pausedRow?.bytes, 500, 'a resumed upload keeps its progress');

    setSnapshot((prev) => ({
      ...prev,
      davRow: makeTransferRow({
        id: 'davRow',
        direction: 'up',
        protocol: 'webdav',
        name: 'w',
        bytes: 400,
        total: 1000,
        status: 'paused',
        connectionId: 'c1',
        localFile: 'L3',
        remoteTarget: 'R3',
        startedAt: 3,
      }),
    }));
    mockApi._nextUpload = resolvedDeferred<CommandResult>({ ok: true });
    await act(async () => {
      await getApi().retryTransfer('davRow', () => {});
    });
    assert.equal(
      calls.upload.at(-1)?.resume,
      false,
      'WebDAV cannot append, so even a paused row starts over',
    );
    assert.equal(getSnapshot().davRow?.bytes, 0);

    setSnapshot((prev) => ({
      ...prev,
      stoppedRow: makeTransferRow({
        id: 'stoppedRow',
        direction: 'up',
        protocol: 'ftp',
        name: 'y',
        bytes: 300,
        total: 1000,
        status: 'stopped',
        connectionId: 'c1',
        localFile: 'L2',
        remoteTarget: 'R2',
        startedAt: 2,
      }),
    }));
    mockApi._nextUpload = resolvedDeferred<CommandResult>({ ok: true });
    await act(async () => {
      await getApi().retryTransfer('stoppedRow', () => {});
    });
    assert.equal(calls.upload.at(-1)?.resume, false);
    assert.equal(
      getSnapshot().stoppedRow?.bytes,
      0,
      'restart from scratch after Stop, not the stale total',
    );

    setSnapshot((prev) => ({
      ...prev,
      networkRow: makeTransferRow({
        id: 'networkRow',
        direction: 'down',
        protocol: 'sftp',
        name: 'z',
        bytes: 700,
        total: 1000,
        status: 'error',
        errorCode: 'connectionLost',
        connectionId: 'c1',
        remoteFile: 'R3',
        localTarget: 'L3',
        startedAt: 3,
      }),
    }));
    mockApi._nextDownload = resolvedDeferred<CommandResult>({ ok: true });
    await act(async () => {
      await getApi().retryTransfer('networkRow', () => {});
    });
    assert.equal(calls.download.at(-1)?.resume, true);
    assert.equal(getSnapshot().networkRow?.bytes, 700);
  });
});

test('cancelling a transfer that already reached a terminal state is a no-op (status-guard race)', async () => {
  await withHarness(async ({ getApi, getSnapshot, setSnapshot, calls }) => {
    setSnapshot(() => ({
      t9: makeTransferRow({
        id: 't9',
        direction: 'down',
        protocol: 'ftp',
        name: 'z',
        bytes: 100,
        total: 100,
        status: 'done',
        connectionId: 'c1',
        startedAt: 1,
      }),
    }));
    await act(async () => {
      await getApi().pauseTransfer('t9');
    });
    assert.equal(
      getSnapshot().t9?.status,
      'done',
      'a finished row cannot be clobbered back to paused',
    );
    assert.equal(calls.cancel.length, 0, 'nothing live to cancel for an already-finished transfer');
  });
});

test('pauseAllTransfers only pauses uploads that can prove a resume, but stopAllTransfers reaches everything active', async () => {
  await withHarness(async ({ getApi, getSnapshot, calls, mockApi }) => {
    const { id: sftpId, runPromise: sftpRun } = await startStuckUpload(
      getApi,
      getSnapshot,
      'c1',
      'sftp',
    );
    const { id: davId, runPromise: davRun } = await startStuckUpload(
      getApi,
      getSnapshot,
      'c2',
      'webdav',
    );

    await act(async () => {
      getApi().pauseAllTransfers();
    });
    assert.equal(getSnapshot()[sftpId]?.status, 'cancelling');
    assert.equal(
      getSnapshot()[davId]?.status,
      'queued',
      'a WebDAV upload cannot append to staging at all, so it is never offered a pause',
    );
    assert.deepEqual(calls.cancel, [
      { connectionId: 'c1', id: getSnapshot()[sftpId]?.attemptId, intent: 'pause' },
    ]);

    await act(async () => {
      getApi().stopAllTransfers();
    });
    assert.equal(
      getSnapshot()[sftpId]?.status,
      'cancelling',
      'stop also reaches an already-paused row',
    );
    assert.equal(
      getSnapshot()[davId]?.status,
      'cancelling',
      'stop reaches a still-running WebDAV upload too',
    );
    assert.deepEqual(
      calls.cancel.map((call) => call.intent),
      ['pause', 'stop'],
      'a stop is never sent as a pause: only a pause may keep staging on the server',
    );
    await act(async () => {
      mockApi._nextUpload.resolve({ ok: false, errorCode: 'cancelled' });
      await Promise.all([sftpRun, davRun]);
    });
    assert.equal(getSnapshot()[sftpId]?.status, 'stopped');
    assert.equal(getSnapshot()[davId]?.status, 'stopped');
  });
});

test('an upload asks to resume only after a pause, never after a stop', async () => {
  await withHarness(async ({ getApi, getSnapshot, calls, mockApi }) => {
    const { id, runPromise } = await startStuckUpload(getApi, getSnapshot, 'c1', 'sftp');
    assert.equal(calls.upload[0]?.resume, false, 'a first attempt has no staging to append to');

    await act(async () => {
      await getApi().pauseTransfer(id);
      mockApi._nextUpload.resolve({ ok: false, errorCode: 'cancelled' });
      await runPromise;
    });
    assert.equal(getSnapshot()[id]?.status, 'paused');

    mockApi._nextUpload = createDeferred<CommandResult>();
    let resumed!: Promise<void>;
    await act(async () => {
      resumed = getApi().retryTransfer(id);
      await Promise.resolve();
    });
    assert.equal(
      calls.upload.at(-1)?.resume,
      true,
      'resuming a paused upload appends to the staging it left behind',
    );

    await act(async () => {
      await getApi().stopTransfer(id);
      mockApi._nextUpload.resolve({ ok: false, errorCode: 'cancelled' });
      await resumed;
    });
    assert.equal(getSnapshot()[id]?.status, 'stopped');

    mockApi._nextUpload = createDeferred<CommandResult>();
    let restarted!: Promise<void>;
    await act(async () => {
      restarted = getApi().retryTransfer(id);
      await Promise.resolve();
    });
    assert.equal(
      calls.upload.at(-1)?.resume,
      false,
      'a stop discards the staging server-side, so its retry has to start over',
    );
    await act(async () => {
      mockApi._nextUpload.resolve({ ok: true });
      await restarted;
    });
  });
});

test('disconnecting settles every transfer on that connection, paused ones included', async () => {
  await withHarness(async ({ getApi, getSnapshot, setSnapshot, calls, mockApi }) => {
    const { id: running, runPromise } = await startStuckUpload(getApi, getSnapshot, 'c1', 'sftp');
    setSnapshot((previous) => ({
      ...previous,
      pausedUpload: makeTransferRow({
        id: 'pausedUpload',
        direction: 'up',
        name: 'paused.bin',
        status: 'paused',
        protocol: 'sftp',
        connectionId: 'c1',
        localFile: 'C:\\local\\paused.bin',
        remoteTarget: '/remote/dir/paused.bin',
        bytes: 500,
      }),
      pausedDownload: makeTransferRow({
        id: 'pausedDownload',
        direction: 'down',
        name: 'grab.bin',
        status: 'paused',
        protocol: 'sftp',
        connectionId: 'c1',
        remoteFile: '/remote/dir/grab.bin',
        localTarget: 'C:\\local\\grab.bin',
      }),
      elsewhere: makeTransferRow({
        id: 'elsewhere',
        direction: 'up',
        name: 'other.bin',
        status: 'paused',
        protocol: 'sftp',
        connectionId: 'c2',
        localFile: 'C:\\local\\other.bin',
        remoteTarget: '/remote/dir/other.bin',
      }),
    }));

    await act(async () => {
      await getApi().stopTransfersForConnection('c1');
    });

    assert.equal(getSnapshot()[running]?.status, 'cancelling');
    assert.deepEqual(
      calls.cancel,
      [{ connectionId: 'c1', id: getSnapshot()[running]?.attemptId, intent: 'stop' }],
      'a teardown never asks the backend to keep staging it is about to delete',
    );
    assert.equal(
      getSnapshot().pausedUpload?.status,
      'stopped',
      'the connection id dies here and is never reissued, so a paused row would promise a resume that can only fail',
    );
    assert.equal(getSnapshot().pausedDownload?.status, 'stopped');
    assert.equal(
      getSnapshot().elsewhere?.status,
      'paused',
      'another connection keeps its own paused rows',
    );

    await act(async () => {
      mockApi._nextUpload.resolve({ ok: false, errorCode: 'cancelled' });
      await runPromise;
    });
    assert.equal(getSnapshot()[running]?.status, 'stopped');

    const uploadsBeforeRetry = calls.upload.length;
    await act(async () => {
      await getApi().retryTransfer('pausedUpload');
    });
    assert.equal(
      calls.upload.length,
      uploadsBeforeRetry,
      'the connection this row named is gone for good, so retrying it must not even try',
    );
    assert.equal(getSnapshot().pausedUpload?.status, 'stopped');
  });
});

test('summary flags (hasActiveTransfers/hasPausedTransfers/hasRetryableTransfers/...) track the lifecycle', async () => {
  await withHarness(async ({ getApi, getSnapshot, mockApi }) => {
    const { id, runPromise } = await startStuckUpload(getApi, getSnapshot, 'c1', 'sftp');

    assert.equal(getApi().hasActiveTransfers, true);
    assert.equal(getApi().activeTransfersCount, 1);
    assert.equal(getApi().hasPausableTransfers, true);
    assert.equal(getApi().transfersEmpty, false);

    await act(async () => {
      await getApi().pauseTransfer(id);
    });
    assert.equal(getApi().hasActiveTransfers, true, 'cancelling still owns its worker');
    await act(async () => {
      mockApi._nextUpload.resolve({ ok: false, errorCode: 'cancelled' });
      await runPromise;
    });
    assert.equal(getApi().hasActiveTransfers, false);
    assert.equal(getApi().hasPausedTransfers, true);

    await act(async () => {
      await getApi().stopTransfer(id);
    });
    assert.equal(getApi().hasPausedTransfers, false);
    assert.equal(getApi().hasRetryableTransfers, true);
    assert.equal(getApi().hasCompletedTransfers, true);

    await act(async () => {
      getApi().clearCompletedTransfers();
    });
    assert.equal(getApi().transfersEmpty, true);
    assert.equal(getApi().hasCompletedTransfers, false);
  });
});

test('buffered progress and error events cannot settle a cancelling attempt before its command returns', async () => {
  await withHarness(async ({ getApi, getSnapshot, emitProgress, mockApi }) => {
    const { id, runPromise } = await startStuckUpload(getApi, getSnapshot, 'c1', 'sftp');

    await act(async () => {
      await getApi().pauseTransfer(id);
    });
    assert.equal(getSnapshot()[id]?.status, 'cancelling');

    // A progress update may already be buffered when pause is clicked. It
    // must not resurrect the row as active or leave the pause icon visible.
    act(() => {
      emitProgress({
        id: getSnapshot()[id]!.attemptId!,
        connectionId: 'c1',
        status: 'progress',
        bytes: 450,
        total: 1000,
      });
    });
    assert.equal(getSnapshot()[id]?.status, 'cancelling');

    // The backend then surfaces the connection drop as a plain error — the
    // user's intent still wins over that transport detail.
    act(() => {
      emitProgress({
        id: getSnapshot()[id]!.attemptId!,
        connectionId: 'c1',
        status: 'error',
        bytes: 500,
        total: 1000,
      });
    });
    assert.equal(
      getSnapshot()[id]?.status,
      'cancelling',
      "stays labeled as the user's own Pause, not Error",
    );
    await act(async () => {
      mockApi._nextUpload.resolve({ ok: false, errorCode: 'cancelled' });
      await runPromise;
    });
    assert.equal(getSnapshot()[id]?.status, 'paused');
  });
});

test('a native drag-out download announced by the backend gets a queue row that progress events then drive', async () => {
  await withHarness(async ({ getApi, getSnapshot, calls, emitDragOutStarted, emitProgress }) => {
    act(() => {
      emitDragOutStarted({
        id: 'dragout-1',
        connectionId: 'c1',
        protocol: 'sftp',
        name: 'photo.jpg',
        remoteFile: '/remote/photo.jpg',
        total: 1000,
      });
    });
    const row = getSnapshot()['dragout-1'];
    assert.ok(row, 'the announcement creates the row — nothing else will');
    assert.equal(row.direction, 'down');
    assert.equal(row.status, 'progress');
    assert.equal(row.dragOut, true);
    assert.equal(row.total, 1000);

    act(() => {
      emitProgress({ id: 'dragout-1', connectionId: 'c1', status: 'progress', bytes: 400 });
    });
    assert.equal(getSnapshot()['dragout-1']?.bytes, 400);

    // Announced twice (defensive: Explorer re-requesting the same file) must
    // not reset a row that's already underway.
    act(() => {
      emitDragOutStarted({
        id: 'dragout-1',
        connectionId: 'c1',
        protocol: 'sftp',
        name: 'photo.jpg',
        remoteFile: '/remote/photo.jpg',
      });
    });
    assert.equal(getSnapshot()['dragout-1']?.bytes, 400);

    assert.equal(getApi().hasPausableTransfers, false, 'Explorer owns the destination: no pause');
    await act(async () => {
      getApi().pauseAllTransfers();
    });
    assert.equal(calls.cancel.length, 0);
    assert.equal(getSnapshot()['dragout-1']?.status, 'progress');

    await act(async () => {
      await getApi().stopTransfer('dragout-1');
    });
    assert.deepEqual(calls.cancel, [{ connectionId: 'c1', id: 'dragout-1', intent: 'stop' }]);
    assert.equal(getSnapshot()['dragout-1']?.status, 'cancelling');
    assert.equal(calls.fsLocalDelete.length, 0, 'no local partial of ours to clean up');

    // The backend reports the cancelled stream as an error — the user's own
    // Stop still wins the label, exactly as for ordinary transfers.
    act(() => {
      emitProgress({
        id: 'dragout-1',
        connectionId: 'c1',
        status: 'error',
        error: 'Canceled by user',
        errorCode: 'cancelled',
      });
    });
    assert.equal(getSnapshot()['dragout-1']?.status, 'stopped');

    await act(async () => {
      await getApi().retryTransfer('dragout-1');
    });
    assert.equal(calls.download.length, 0, 'nothing to retry into — Explorer picked the target');
    assert.equal(getSnapshot()['dragout-1']?.status, 'stopped');
  });
});

test('OS notification fires once per queue drain, tallying succeeded/failed, not once per file', async () => {
  await withHarness(async ({ setSnapshot, calls }) => {
    setSnapshot(() => ({
      a: makeTransferRow({ id: 'a', status: 'progress', direction: 'up', name: 'a' }),
      b: makeTransferRow({ id: 'b', status: 'progress', direction: 'up', name: 'b' }),
    }));
    assert.equal(calls.notifyTransfersComplete.length, 0);

    setSnapshot((prev) => ({ ...prev, a: withStatus(prev.a, 'done') }));
    assert.equal(calls.notifyTransfersComplete.length, 0, 'queue still has an active transfer');

    // Second (and last) file lands — queue just drained, single notify
    // tallying both outcomes.
    setSnapshot((prev) => ({ ...prev, b: withStatus(prev.b, 'error') }));
    assert.equal(calls.notifyTransfersComplete.length, 1);
    // title/body are pre-translated by i18next before reaching window.api —
    // this test only cares about the tally, not the wording.
    assert.equal(calls.notifyTransfersComplete[0]?.succeeded, 1);
    assert.equal(calls.notifyTransfersComplete[0]?.failed, 1);

    // A later, independent transfer draining on its own must not re-tally
    // rows already reported in the previous drain.
    setSnapshot((prev) => ({
      ...prev,
      c: makeTransferRow({ id: 'c', status: 'progress', direction: 'up', name: 'c' }),
    }));
    setSnapshot((prev) => ({ ...prev, c: withStatus(prev.c, 'done') }));
    assert.equal(calls.notifyTransfersComplete.length, 2);
    assert.equal(calls.notifyTransfersComplete[1]?.succeeded, 1);
    assert.equal(calls.notifyTransfersComplete[1]?.failed, 0);
  });
});

test('a progress event flushed after a folder walk settles cannot strand its row', async () => {
  await withHarness(async ({ getApi, mockApi, getSnapshot, emitProgress }) => {
    let attemptId = '';
    mockApi.transfer.recursive = async (intent) => {
      attemptId = intent.id;
      return { ok: true, outcome: 'complete', scanned: 2, completed: 2, errors: [] };
    };
    await act(async () => {
      await getApi().copyEntries(localFolderMove());
    });
    const id = Object.keys(getSnapshot())[0]!;
    assert.equal(getSnapshot()[id]!.status, 'done');

    // The backend batches in-progress payloads behind a flush timer, so the
    // walk's last one arrives after the command that sent it has resolved.
    act(() => {
      emitProgress({ id: attemptId, connectionId: '', status: 'progress', bytes: 8, total: 8 });
    });
    assert.equal(getSnapshot()[id]!.status, 'done');

    // Stop would otherwise mark a revived row 'cancelling' and wait forever
    // for an attempt the backend has already forgotten.
    await act(async () => {
      await getApi().stopTransfer(id);
    });
    assert.equal(getSnapshot()[id]!.status, 'done');
  });
});
