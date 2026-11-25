import { api } from '../../platform/api/index.ts';
import type { TerminalApi, TerminalEvent } from '../../platform/api/terminal.ts';
import { clipboard } from '../../platform/clipboard.ts';
import { hostPlatform } from '../../platform/os.ts';
import type { Platform } from '../../platform/os.ts';
import { reportRejection } from '../../shared/asyncFailure.ts';
import { classifyTerminalKey } from './terminalKeymap.ts';
import { readDocumentTerminalTheme } from './terminalTheme.ts';
import type { TerminalTheme } from './terminalTheme.ts';
import { createXtermInstance } from './xtermRuntime.ts';
import type { XtermFactory, XtermInstance } from './xtermRuntime.ts';

export type TerminalMode = 'closed' | 'split' | 'collapsed' | 'maximized';
export type TerminalDock = 'same' | 'other';
export type TerminalStatus = 'connecting' | 'open' | 'exited' | 'refused' | 'error';

export interface TerminalSessionSnapshot {
  readonly connectionId: string;
  readonly mode: TerminalMode;
  readonly dock: TerminalDock;
  readonly status: TerminalStatus;
  readonly terminalId: string | null;
  readonly exitCode: number | null;
  readonly message: string | null;
  readonly hostElement: HTMLDivElement | null;
  readonly hasSelection: boolean;
}

interface InternalSession {
  connectionId: string;
  mode: Exclude<TerminalMode, 'closed'>;
  dock: TerminalDock;
  status: TerminalStatus;
  terminalId: string | null;
  exitCode: number | null;
  message: string | null;
  hostElement: HTMLDivElement | null;
  hasSelection: boolean;
  savedScrollFromBottom: number | null;
  xterm: XtermInstance | null;
  opened: boolean;
  dataSubscription: { dispose(): void } | null;
  selectionSubscription: { dispose(): void } | null;
  cols: number;
  rows: number;
  generation: number;
  pendingWrite: Promise<void>;
}

export interface TerminalStoreDeps {
  terminalApi?: () => TerminalApi;
  createXterm?: XtermFactory;
  readTheme?: () => { theme: TerminalTheme; fontFamily: string };
  writeClipboard?: (text: string) => Promise<void>;
  readClipboard?: () => Promise<string>;
  getPlatform?: () => Platform;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Safely under Rust's 64 KiB `MAX_WRITE_BYTES` even with 4-byte UTF-8 code points. */
const MAX_WRITE_CHARS = 16 * 1024;

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toSnapshot(entry: InternalSession): TerminalSessionSnapshot {
  return {
    connectionId: entry.connectionId,
    mode: entry.mode,
    dock: entry.dock,
    status: entry.status,
    terminalId: entry.terminalId,
    exitCode: entry.exitCode,
    message: entry.message,
    hostElement: entry.hostElement,
    hasSelection: entry.hasSelection,
  };
}

export function createTerminalStore(deps: TerminalStoreDeps = {}) {
  const getApi = deps.terminalApi ?? (() => api.terminal);
  const createXterm = deps.createXterm ?? createXtermInstance;
  const readTheme = deps.readTheme ?? readDocumentTerminalTheme;
  const writeClipboard = deps.writeClipboard ?? ((text: string) => clipboard.writeText(text));
  const readClipboard = deps.readClipboard ?? (() => clipboard.readText());
  const getPlatform = deps.getPlatform ?? hostPlatform;

  const sessions = new Map<string, InternalSession>();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlyMap<string, TerminalSessionSnapshot> = new Map();

  function emit(): void {
    const next = new Map<string, TerminalSessionSnapshot>();
    for (const [id, entry] of sessions) {
      next.set(id, toSnapshot(entry));
    }
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  }

  function ensureHostElement(entry: InternalSession): HTMLDivElement | null {
    if (typeof document === 'undefined') return null;
    if (!entry.hostElement) {
      const host = document.createElement('div');
      host.className = 'terminal-host';
      entry.hostElement = host;
    }
    return entry.hostElement;
  }

  function openXtermIfConnected(entry: InternalSession): void {
    if (!entry.xterm || entry.opened || !entry.hostElement || !entry.hostElement.isConnected) {
      return;
    }
    entry.xterm.open(entry.hostElement);
    entry.opened = true;
  }

  function restoreAndSync(entry: InternalSession, shouldFocus: boolean): void {
    if (sessions.get(entry.connectionId) !== entry || entry.mode === 'collapsed') return;
    syncResize(entry.connectionId);
    if (entry.xterm) {
      if (entry.savedScrollFromBottom !== null) {
        entry.xterm.restoreScrollFromBottom(entry.savedScrollFromBottom);
        entry.savedScrollFromBottom = null;
      }
      entry.xterm.refresh();
      if (shouldFocus) {
        entry.xterm.focus();
      }
    }
  }

  function schedulePostLayoutSync(entry: InternalSession, shouldFocus: boolean): void {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => restoreAndSync(entry, shouldFocus));
    } else {
      restoreAndSync(entry, shouldFocus);
    }
  }

  function sendInput(entry: InternalSession, data: string): void {
    const terminalId = entry.terminalId;
    if (!terminalId || entry.status !== 'open' || data.length === 0) return;

    // Chain writes sequentially so pasted chunks reach the PTY in exact order
    // without splitting UTF-16 surrogate pairs across chunk boundaries.
    entry.pendingWrite = entry.pendingWrite.then(async () => {
      let offset = 0;
      while (offset < data.length) {
        if (entry.terminalId !== terminalId || entry.status !== 'open') return;
        let end = Math.min(offset + MAX_WRITE_CHARS, data.length);
        if (end < data.length) {
          const code = data.charCodeAt(end - 1);
          if (code >= 0xd800 && code <= 0xdbff) {
            end -= 1;
          }
        }
        const chunk = data.slice(offset, end);
        offset = end;
        await getApi().write(terminalId, chunk);
      }
    });
    reportRejection(entry.pendingWrite);
  }

  function attachKeyHandler(entry: InternalSession, xterm: XtermInstance): void {
    xterm.attachCustomKeyEventHandler((event) => {
      const action = classifyTerminalKey(event, getPlatform(), xterm.hasSelection());
      if (action === 'pty') return true;
      if (action === 'pass-through-app') return false;
      if (action === 'prevent-browser') {
        if (event.type === 'keydown') event.preventDefault();
        return false;
      }
      if (event.type !== 'keydown') return false;
      event.preventDefault();
      if (action === 'copy') {
        if (xterm.hasSelection()) {
          reportRejection(writeClipboard(xterm.getSelection()));
          // Clear selection after bare Ctrl+C so a follow-up Ctrl+C sends SIGINT.
          if (event.code === 'KeyC' && event.ctrlKey && !event.shiftKey && !event.metaKey) {
            xterm.clearSelection();
          }
        }
      } else if (action === 'paste') {
        reportRejection(
          readClipboard().then((text) => {
            if (text && entry.xterm === xterm && entry.status === 'open') {
              xterm.paste(text);
            }
          }),
        );
      } else if (action === 'select-all') {
        xterm.selectAll();
      } else {
        xterm.clear();
      }
      return false;
    });
  }

  async function ensureXterm(entry: InternalSession): Promise<XtermInstance> {
    if (entry.xterm) {
      openXtermIfConnected(entry);
      return entry.xterm;
    }
    const { theme, fontFamily } = readTheme();
    const xterm = await createXterm({ theme, fontFamily });
    if (sessions.get(entry.connectionId) !== entry) {
      xterm.dispose();
      throw new Error('Terminal closed before runtime initialized');
    }
    ensureHostElement(entry);
    attachKeyHandler(entry, xterm);
    entry.dataSubscription = xterm.onData((data) => sendInput(entry, data));
    entry.selectionSubscription = xterm.onSelectionChange(() => {
      const next = xterm.hasSelection();
      if (entry.hasSelection !== next) {
        entry.hasSelection = next;
        emit();
      }
    });
    entry.hasSelection = xterm.hasSelection();
    entry.xterm = xterm;
    openXtermIfConnected(entry);
    emit();
    return xterm;
  }

  function handleBackendEvent(
    entry: InternalSession,
    generation: number,
    event: TerminalEvent,
  ): void {
    if (sessions.get(entry.connectionId) !== entry || entry.generation !== generation) return;

    if (event.event === 'output') {
      const terminalId = entry.terminalId;
      const bytes = decodeBase64(event.data);
      if (entry.xterm) {
        entry.xterm.write(bytes, () => {
          if (terminalId && entry.terminalId === terminalId) {
            reportRejection(getApi().ack(terminalId, event.bytes));
          }
        });
      } else if (terminalId) {
        reportRejection(getApi().ack(terminalId, event.bytes));
      }
      return;
    }

    if (event.event === 'exit') {
      entry.status = 'exited';
      entry.exitCode = typeof event.code === 'number' ? event.code : null;
      entry.terminalId = null;
      emit();
      return;
    }

    if (entry.status !== 'exited' && entry.status !== 'refused') {
      entry.status = 'exited';
      entry.message = event.reason ?? null;
    }
    entry.terminalId = null;
    emit();
  }

  async function openChannel(entry: InternalSession): Promise<void> {
    const generation = ++entry.generation;
    const prevTerminalId = entry.terminalId;
    entry.terminalId = null;
    entry.status = 'connecting';
    entry.exitCode = null;
    entry.message = null;
    emit();

    if (prevTerminalId) {
      reportRejection(getApi().close(prevTerminalId));
    }

    let xterm: XtermInstance;
    try {
      xterm = await ensureXterm(entry);
    } catch {
      return;
    }
    if (sessions.get(entry.connectionId) !== entry || entry.generation !== generation) return;

    const fitted = entry.opened || typeof document === 'undefined' ? xterm.fit() : null;
    const cols = fitted?.cols ?? (entry.cols || DEFAULT_COLS);
    const rows = fitted?.rows ?? (entry.rows || DEFAULT_ROWS);
    entry.cols = cols;
    entry.rows = rows;

    const result = await getApi().open(entry.connectionId, cols, rows, (event) => {
      handleBackendEvent(entry, generation, event);
    });

    if (sessions.get(entry.connectionId) !== entry || entry.generation !== generation) {
      if (result.ok && result.outcome === 'opened') {
        reportRejection(getApi().close(result.terminalId));
      }
      return;
    }

    if (!result.ok) {
      entry.status = 'error';
      entry.message = result.error ?? null;
      emit();
      return;
    }

    if (result.outcome === 'shellRefused') {
      entry.status = 'refused';
      entry.message = result.message;
      emit();
      return;
    }

    entry.terminalId = result.terminalId;
    entry.status = 'open';
    entry.message = null;
    emit();

    schedulePostLayoutSync(entry, true);
  }

  function attachHost(connectionId: string, container: HTMLElement): () => void {
    const entry = sessions.get(connectionId);
    if (!entry) return () => {};
    const host = ensureHostElement(entry);
    if (!host) return () => {};
    if (host.parentNode !== container) {
      container.appendChild(host);
    }
    openXtermIfConnected(entry);
    schedulePostLayoutSync(entry, false);
    return () => {
      if (entry.xterm && entry.mode !== 'collapsed') {
        entry.savedScrollFromBottom = entry.xterm.getScrollFromBottom();
      }
      if (host.parentNode === container) {
        container.removeChild(host);
      }
    };
  }

  function open(connectionId: string): Promise<void> {
    const existing = sessions.get(connectionId);
    if (existing) {
      if (existing.mode === 'collapsed') {
        setMode(connectionId, 'split');
      }
      if (existing.status === 'open' || existing.status === 'connecting') {
        existing.xterm?.focus();
        return Promise.resolve();
      }
      return openChannel(existing);
    }

    const entry: InternalSession = {
      connectionId,
      mode: 'split',
      dock: 'same',
      status: 'connecting',
      terminalId: null,
      exitCode: null,
      message: null,
      hostElement: null,
      hasSelection: false,
      savedScrollFromBottom: null,
      xterm: null,
      opened: false,
      dataSubscription: null,
      selectionSubscription: null,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      generation: 0,
      pendingWrite: Promise.resolve(),
    };
    ensureHostElement(entry);
    sessions.set(connectionId, entry);
    emit();
    return openChannel(entry);
  }

  function setMode(connectionId: string, nextMode: Exclude<TerminalMode, 'closed'>): void {
    const entry = sessions.get(connectionId);
    if (!entry || entry.mode === nextMode) return;
    if (nextMode === 'collapsed') {
      if (entry.xterm) {
        entry.savedScrollFromBottom = entry.xterm.getScrollFromBottom();
      }
      entry.mode = 'collapsed';
      emit();
      return;
    }
    entry.mode = nextMode;
    emit();
    schedulePostLayoutSync(entry, true);
  }

  function expand(connectionId: string): void {
    const entry = sessions.get(connectionId);
    if (entry?.mode === 'collapsed') {
      setMode(connectionId, 'split');
    }
  }

  function toggle(connectionId: string): void {
    const existing = sessions.get(connectionId);
    if (!existing) {
      reportRejection(open(connectionId));
      return;
    }
    if (existing.mode === 'collapsed') {
      setMode(connectionId, 'split');
      return;
    }
    close(connectionId);
  }

  function toggleCollapse(connectionId: string): void {
    const entry = sessions.get(connectionId);
    if (!entry) return;
    setMode(connectionId, entry.mode === 'collapsed' ? 'split' : 'collapsed');
  }

  function toggleMaximize(connectionId: string): void {
    const entry = sessions.get(connectionId);
    if (!entry) return;
    setMode(connectionId, entry.mode === 'maximized' ? 'split' : 'maximized');
  }

  function setDock(connectionId: string, nextDock: TerminalDock): void {
    const entry = sessions.get(connectionId);
    if (!entry || entry.dock === nextDock) return;
    entry.dock = nextDock;
    if (nextDock === 'other' && entry.mode === 'collapsed') {
      entry.mode = 'split';
    }
    emit();
    schedulePostLayoutSync(entry, true);
  }

  function toggleDock(connectionId: string): void {
    const entry = sessions.get(connectionId);
    if (!entry) return;
    setDock(connectionId, entry.dock === 'other' ? 'same' : 'other');
  }

  function reconnect(connectionId: string): Promise<void> {
    const entry = sessions.get(connectionId);
    if (!entry) return open(connectionId);
    if (entry.mode === 'collapsed') {
      entry.mode = 'split';
    }
    return openChannel(entry);
  }

  function close(connectionId: string): void {
    const entry = sessions.get(connectionId);
    if (!entry) return;
    sessions.delete(connectionId);
    entry.generation += 1;
    const terminalId = entry.terminalId;
    entry.terminalId = null;
    entry.hasSelection = false;
    entry.savedScrollFromBottom = null;
    entry.dataSubscription?.dispose();
    entry.dataSubscription = null;
    entry.selectionSubscription?.dispose();
    entry.selectionSubscription = null;
    entry.xterm?.dispose();
    entry.xterm = null;
    entry.opened = false;
    entry.hostElement?.remove();
    entry.hostElement = null;
    emit();
    if (terminalId) {
      reportRejection(getApi().close(terminalId));
    }
  }

  function closeAll(): void {
    for (const id of [...sessions.keys()]) {
      close(id);
    }
  }

  function syncResize(connectionId: string): void {
    const entry = sessions.get(connectionId);
    if (!entry || !entry.xterm || entry.mode === 'collapsed') return;
    if (typeof document !== 'undefined' && !entry.opened) return;
    const next = entry.xterm.fit();
    if (!next) return;
    if (next.cols === entry.cols && next.rows === entry.rows) return;
    entry.cols = next.cols;
    entry.rows = next.rows;
    if (entry.terminalId && entry.status === 'open') {
      reportRejection(getApi().resize(entry.terminalId, next.cols, next.rows));
    }
  }

  function updateTheme(nextTheme?: TerminalTheme, nextFontFamily?: string): void {
    if (sessions.size === 0) return;
    const resolved = nextTheme ? { theme: nextTheme, fontFamily: nextFontFamily } : readTheme();
    for (const entry of sessions.values()) {
      entry.xterm?.setTheme(resolved.theme, resolved.fontFamily);
    }
  }

  function copySelection(connectionId: string): boolean {
    const xterm = sessions.get(connectionId)?.xterm;
    if (!xterm || !xterm.hasSelection()) return false;
    reportRejection(writeClipboard(xterm.getSelection()));
    xterm.focus();
    return true;
  }

  function hasSelection(connectionId: string): boolean {
    return sessions.get(connectionId)?.xterm?.hasSelection() ?? false;
  }

  function pasteFromClipboard(connectionId: string): void {
    const entry = sessions.get(connectionId);
    if (!entry?.xterm || entry.status !== 'open') return;
    const xterm = entry.xterm;
    reportRejection(
      readClipboard().then((text) => {
        if (text && entry.xterm === xterm && entry.status === 'open') {
          xterm.paste(text);
          xterm.focus();
        }
      }),
    );
  }

  function selectAll(connectionId: string): void {
    const xterm = sessions.get(connectionId)?.xterm;
    xterm?.selectAll();
  }

  function clear(connectionId: string): void {
    const xterm = sessions.get(connectionId)?.xterm;
    xterm?.clear();
    xterm?.focus();
  }

  function focus(connectionId: string): void {
    sessions.get(connectionId)?.xterm?.focus();
  }

  return {
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: (): ReadonlyMap<string, TerminalSessionSnapshot> => snapshot,
    getSession(connectionId: string): TerminalSessionSnapshot | null {
      return snapshot.get(connectionId) ?? null;
    },
    attachHost,
    open,
    setMode,
    expand,
    toggle,
    toggleCollapse,
    toggleMaximize,
    setDock,
    toggleDock,
    reconnect,
    close,
    closeAll,
    syncResize,
    updateTheme,
    copySelection,
    hasSelection,
    pasteFromClipboard,
    selectAll,
    clear,
    focus,
  };
}

export type TerminalStore = ReturnType<typeof createTerminalStore>;
export const terminalStore = createTerminalStore();
