import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalStore } from '../../../src/features/terminal/index.ts';
import type { XtermInstance } from '../../../src/features/terminal/index.ts';
import type {
  TerminalApi,
  TerminalEvent,
  TerminalOpenResult,
} from '../../../src/platform/api/terminal.ts';

interface FakeXtermHandle {
  instance: XtermInstance;
  writes: Uint8Array[];
  pasted: string[];
  disposed: boolean;
  focused: number;
  refreshed: number;
  scrollFromBottom: number;
  restoredScrolls: number[];
  themesApplied: number;
  emitInput: (_data: string) => void;
  setFitSize: (_cols: number, _rows: number) => void;
  setSelection: (_text: string) => void;
  triggerKey: (_event: Partial<KeyboardEvent>) => boolean;
}

function makeFakeXterm(initialCols = 80, initialRows = 24): FakeXtermHandle {
  let cols = initialCols;
  let rows = initialRows;
  let selection = '';
  let dataHandler: ((_data: string) => void) | null = null;
  let selectionHandler: (() => void) | null = null;
  let keyHandler: ((_event: KeyboardEvent) => boolean) | null = null;
  const writes: Uint8Array[] = [];
  const pasted: string[] = [];
  const restoredScrolls: number[] = [];
  const handle: FakeXtermHandle = {
    writes,
    pasted,
    disposed: false,
    focused: 0,
    refreshed: 0,
    scrollFromBottom: 0,
    restoredScrolls,
    themesApplied: 0,
    emitInput(data: string) {
      dataHandler?.(data);
    },
    setFitSize(nextCols: number, nextRows: number) {
      cols = nextCols;
      rows = nextRows;
    },
    setSelection(text: string) {
      selection = text;
      selectionHandler?.();
    },
    triggerKey(event: Partial<KeyboardEvent>) {
      const fullEvent = {
        type: 'keydown',
        code: '',
        key: '',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        preventDefault() {},
        ...event,
      } as KeyboardEvent;
      return keyHandler ? keyHandler(fullEvent) : true;
    },
    instance: {
      get cols() {
        return cols;
      },
      get rows() {
        return rows;
      },
      open() {},
      fit() {
        return { cols, rows };
      },
      refresh() {
        handle.refreshed += 1;
      },
      getScrollFromBottom() {
        return handle.scrollFromBottom;
      },
      restoreScrollFromBottom(linesFromBottom) {
        handle.restoredScrolls.push(linesFromBottom);
      },
      write(data, callback) {
        writes.push(typeof data === 'string' ? new TextEncoder().encode(data) : data);
        callback?.();
      },
      clear() {},
      selectAll() {
        selection = 'all-text';
        selectionHandler?.();
      },
      clearSelection() {
        selection = '';
        selectionHandler?.();
      },
      getSelection() {
        return selection;
      },
      hasSelection() {
        return selection.length > 0;
      },
      focus() {
        handle.focused += 1;
      },
      paste(text) {
        pasted.push(text);
      },
      setTheme() {
        handle.themesApplied += 1;
      },
      onData(fn) {
        dataHandler = fn;
        return {
          dispose() {
            dataHandler = null;
          },
        };
      },
      onSelectionChange(fn) {
        selectionHandler = fn;
        return {
          dispose() {
            selectionHandler = null;
          },
        };
      },
      attachCustomKeyEventHandler(fn) {
        keyHandler = fn;
      },
      dispose() {
        handle.disposed = true;
      },
    },
  };
  return handle;
}

function makeFakeApi(
  openImpl?: (
    _connId: string,
    _cols: number,
    _rows: number,
    _onEvent: (_e: TerminalEvent) => void,
  ) => Promise<TerminalOpenResult>,
) {
  const calls = {
    open: [] as Array<{ connectionId: string; cols: number; rows: number }>,
    write: [] as Array<{ terminalId: string; data: string }>,
    resize: [] as Array<{ terminalId: string; cols: number; rows: number }>,
    ack: [] as Array<{ terminalId: string; bytes: number }>,
    close: [] as string[],
  };
  let lastOnEvent: ((_e: TerminalEvent) => void) | null = null;
  let seq = 0;

  const api: TerminalApi = {
    async open(connectionId, cols, rows, onEvent) {
      calls.open.push({ connectionId, cols, rows });
      lastOnEvent = onEvent;
      if (openImpl) return openImpl(connectionId, cols, rows, onEvent);
      seq += 1;
      return { ok: true, outcome: 'opened', terminalId: `term-${seq}` };
    },
    async write(terminalId, data) {
      calls.write.push({ terminalId, data });
      return { ok: true };
    },
    async resize(terminalId, cols, rows) {
      calls.resize.push({ terminalId, cols, rows });
      return { ok: true };
    },
    async ack(terminalId, bytes) {
      calls.ack.push({ terminalId, bytes });
      return { ok: true };
    },
    async close(terminalId) {
      calls.close.push(terminalId);
      return { ok: true };
    },
  };

  return {
    api,
    calls,
    emit(event: TerminalEvent) {
      lastOnEvent?.(event);
    },
  };
}

describe('terminalStore', () => {
  it('handles open, output+ack, input, resize, mode transitions and close', async () => {
    const fakeXterm = makeFakeXterm(80, 24);
    const fakeApi = makeFakeApi();
    const store = createTerminalStore({
      terminalApi: () => fakeApi.api,
      createXterm: async () => fakeXterm.instance,
    });

    assert.equal(store.getSession('conn-1'), null);
    await store.open('conn-1');

    const opened = store.getSession('conn-1');
    assert.equal(opened?.mode, 'split');
    assert.equal(opened?.status, 'open');
    assert.equal(opened?.terminalId, 'term-1');

    // Output decodes base64 and sends ack with byte count.
    fakeApi.emit({ event: 'output', data: btoa('hello\r\n'), bytes: 7 });
    assert.equal(new TextDecoder().decode(fakeXterm.writes[0]), 'hello\r\n');
    assert.deepEqual(fakeApi.calls.ack, [{ terminalId: 'term-1', bytes: 7 }]);

    // Input forwards to terminal_write.
    fakeXterm.emitInput('ls\r');
    await Promise.resolve();
    assert.deepEqual(fakeApi.calls.write, [{ terminalId: 'term-1', data: 'ls\r' }]);

    // Resize only fires when cols or rows actually change.
    store.syncResize('conn-1');
    assert.equal(fakeApi.calls.resize.length, 0);
    fakeXterm.setFitSize(120, 36);
    store.syncResize('conn-1');
    assert.deepEqual(fakeApi.calls.resize, [{ terminalId: 'term-1', cols: 120, rows: 36 }]);

    // Mode transitions: split -> collapsed -> split -> maximized -> split.
    // Collapsing saves scrollback offset and expanding restores + refreshes it.
    fakeXterm.scrollFromBottom = 14;
    const refreshBefore = fakeXterm.refreshed;
    store.toggleCollapse('conn-1');
    assert.equal(store.getSession('conn-1')?.mode, 'collapsed');
    // Toolbar toggle when collapsed restores to split instead of closing.
    store.toggle('conn-1');
    assert.equal(store.getSession('conn-1')?.mode, 'split');
    assert.deepEqual(fakeXterm.restoredScrolls, [14]);
    assert.ok(fakeXterm.refreshed > refreshBefore);
    // Explicit expand() expands from collapsed and is a no-op when already open.
    store.toggleCollapse('conn-1');
    store.expand('conn-1');
    assert.equal(store.getSession('conn-1')?.mode, 'split');
    const refreshAfterExpand = fakeXterm.refreshed;
    store.expand('conn-1');
    assert.equal(fakeXterm.refreshed, refreshAfterExpand);
    store.toggleMaximize('conn-1');
    assert.equal(store.getSession('conn-1')?.mode, 'maximized');
    store.toggleMaximize('conn-1');
    assert.equal(store.getSession('conn-1')?.mode, 'split');

    // Theme updates propagate to live xterm instances.
    store.updateTheme();
    assert.equal(fakeXterm.themesApplied, 1);

    // Close disposes xterm and notifies backend.
    store.close('conn-1');
    assert.equal(store.getSession('conn-1'), null);
    assert.equal(fakeXterm.disposed, true);
    assert.deepEqual(fakeApi.calls.close, ['term-1']);
  });

  it('tracks selection state, copies and clears selection on smart Ctrl+C, and pastes on Ctrl+V', async () => {
    const fakeXterm = makeFakeXterm();
    const fakeApi = makeFakeApi();
    const copied: string[] = [];
    const store = createTerminalStore({
      terminalApi: () => fakeApi.api,
      createXterm: async () => fakeXterm.instance,
      getPlatform: () => 'windows',
      writeClipboard: async (text) => {
        copied.push(text);
      },
      readClipboard: async () => 'echo hi',
    });

    await store.open('conn-clip');
    assert.equal(store.getSession('conn-clip')?.hasSelection, false);

    // Without selection, Ctrl+C goes straight to PTY (returns true).
    assert.equal(fakeXterm.triggerKey({ code: 'KeyC', ctrlKey: true }), true);
    assert.deepEqual(copied, []);

    // With selection, Ctrl+C copies and clears selection so a second Ctrl+C sends SIGINT.
    fakeXterm.setSelection('selected-output');
    assert.equal(store.getSession('conn-clip')?.hasSelection, true);
    assert.equal(fakeXterm.triggerKey({ code: 'KeyC', ctrlKey: true }), false);
    assert.deepEqual(copied, ['selected-output']);
    assert.equal(store.getSession('conn-clip')?.hasSelection, false);
    assert.equal(fakeXterm.triggerKey({ code: 'KeyC', ctrlKey: true }), true);

    // Ctrl+V pastes clipboard text into xterm instead of sending ^V to the shell.
    assert.equal(fakeXterm.triggerKey({ code: 'KeyV', ctrlKey: true }), false);
    await Promise.resolve();
    assert.deepEqual(fakeXterm.pasted, ['echo hi']);
  });

  it('transitions to refused on shellRefused and supports exit + reconnect', async () => {
    let attempt = 0;
    const fakeXterm = makeFakeXterm();
    const fakeApi = makeFakeApi(async () => {
      attempt += 1;
      if (attempt === 1) {
        return { ok: true, outcome: 'shellRefused', message: 'SFTP-only account' };
      }
      return { ok: true, outcome: 'opened', terminalId: `term-${attempt}` };
    });
    const store = createTerminalStore({
      terminalApi: () => fakeApi.api,
      createXterm: async () => fakeXterm.instance,
    });

    await store.open('conn-sftp');
    assert.equal(store.getSession('conn-sftp')?.status, 'refused');
    assert.equal(store.getSession('conn-sftp')?.message, 'SFTP-only account');

    await store.reconnect('conn-sftp');
    assert.equal(store.getSession('conn-sftp')?.status, 'open');
    assert.equal(store.getSession('conn-sftp')?.terminalId, 'term-2');

    fakeApi.emit({ event: 'exit', code: 0 });
    assert.equal(store.getSession('conn-sftp')?.status, 'exited');
    assert.equal(store.getSession('conn-sftp')?.exitCode, 0);
    assert.equal(store.getSession('conn-sftp')?.terminalId, null);
  });

  it('closes late backend terminal if session was closed while open was in flight', async () => {
    let resolveOpen!: (_res: TerminalOpenResult) => void;
    const fakeXterm = makeFakeXterm();
    const fakeApi = makeFakeApi(
      () =>
        new Promise<TerminalOpenResult>((resolve) => {
          resolveOpen = resolve;
        }),
    );
    const store = createTerminalStore({
      terminalApi: () => fakeApi.api,
      createXterm: async () => fakeXterm.instance,
    });

    const opening = store.open('conn-race');
    // Wait until ensureXterm finishes and open() is awaiting IPC.
    await Promise.resolve();
    await Promise.resolve();
    store.close('conn-race');
    resolveOpen({ ok: true, outcome: 'opened', terminalId: 'late-term' });
    await opening;

    assert.equal(store.getSession('conn-race'), null);
    assert.deepEqual(fakeApi.calls.close, ['late-term']);
  });
});
