import type { TerminalTheme } from './terminalTheme.ts';

export interface XtermInstance {
  readonly cols: number;
  readonly rows: number;
  open(container: HTMLElement): void;
  fit(): { cols: number; rows: number } | null;
  refresh(): void;
  getScrollFromBottom(): number;
  restoreScrollFromBottom(linesFromBottom: number): void;
  write(data: Uint8Array | string, callback?: () => void): void;
  clear(): void;
  selectAll(): void;
  clearSelection(): void;
  getSelection(): string;
  hasSelection(): boolean;
  focus(): void;
  paste(text: string): void;
  setTheme(theme: TerminalTheme, fontFamily?: string): void;
  setFontSize(fontSize: number): void;
  onData(handler: (data: string) => void): { dispose(): void };
  onSelectionChange(handler: () => void): { dispose(): void };
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  dispose(): void;
}

export interface XtermRuntimeOptions {
  theme: TerminalTheme;
  fontFamily: string;
  fontSize?: number;
}

export type XtermFactory = (options: XtermRuntimeOptions) => Promise<XtermInstance>;

let xtermModulesPromise: Promise<{
  Terminal: typeof import('@xterm/xterm').Terminal;
  FitAddon: typeof import('@xterm/addon-fit').FitAddon;
}> | null = null;

async function loadXtermModules() {
  if (!xtermModulesPromise) {
    xtermModulesPromise = Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/xterm/css/xterm.css'),
    ]).then(([xterm, fit]) => ({
      Terminal: xterm.Terminal,
      FitAddon: fit.FitAddon,
    }));
  }
  return xtermModulesPromise;
}

export const createXtermInstance: XtermFactory = async ({ theme, fontFamily, fontSize = 12 }) => {
  const { Terminal, FitAddon } = await loadXtermModules();
  // Explicitly keep proposed APIs (including OSC 52 clipboard hooks) disabled.
  const term = new Terminal({
    allowProposedApi: false,
    cursorBlink: true,
    cursorStyle: 'block',
    convertEol: false,
    fontFamily,
    fontSize,
    lineHeight: 1.3,
    scrollback: 10000,
    theme,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  return {
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    open(container: HTMLElement) {
      term.open(container);
    },
    fit() {
      const container = term.element?.parentElement;
      if (!container || !container.isConnected) {
        return null;
      }
      // FitAddon clamps collapsed/hidden containers to 2x1, which would reflow
      // and push visible lines off-screen; skip fitting until visibly laid out.
      const rect = container.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 16) {
        return null;
      }
      const dims = fitAddon.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) {
        return null;
      }
      if (dims.cols < 2 || dims.rows < 2) {
        return null;
      }
      fitAddon.fit();
      return { cols: term.cols, rows: term.rows };
    },
    refresh() {
      if (term.rows > 0) {
        term.refresh(0, term.rows - 1);
      }
    },
    getScrollFromBottom() {
      const buffer = term.buffer.active;
      return Math.max(0, buffer.baseY - buffer.viewportY);
    },
    restoreScrollFromBottom(linesFromBottom) {
      if (linesFromBottom <= 0) {
        term.scrollToBottom();
      } else {
        const target = Math.max(0, term.buffer.active.baseY - linesFromBottom);
        term.scrollToLine(target);
      }
    },
    write(data, callback) {
      term.write(data, callback);
    },
    clear() {
      term.clear();
    },
    selectAll() {
      term.selectAll();
    },
    clearSelection() {
      term.clearSelection();
    },
    getSelection() {
      return term.getSelection();
    },
    hasSelection() {
      return term.hasSelection();
    },
    focus() {
      term.focus();
    },
    paste(text) {
      term.paste(text);
    },
    setTheme(nextTheme, nextFontFamily) {
      term.options.theme = nextTheme;
      if (nextFontFamily) {
        term.options.fontFamily = nextFontFamily;
      }
    },
    setFontSize(nextFontSize) {
      term.options.fontSize = nextFontSize;
    },
    onData(handler) {
      return term.onData(handler);
    },
    onSelectionChange(handler) {
      return term.onSelectionChange(handler);
    },
    attachCustomKeyEventHandler(handler) {
      term.attachCustomKeyEventHandler(handler);
    },
    dispose() {
      fitAddon.dispose();
      term.dispose();
    },
  };
};
