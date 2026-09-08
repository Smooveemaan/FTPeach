import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Workspace from '../../../src/app/Workspace.tsx';
import type { WorkspaceProps } from '../../../src/app/Workspace.tsx';
import ErrorBoundary from '../../../src/components/ErrorBoundary.tsx';

vi.mock('../../../src/i18n/index.ts', () => ({ default: { t: (key: string) => key } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../src/features/transfers/ui.ts', () => ({
  TransferQueue: () => {
    if (failure === 'queue') throw new Error('queue render failed');
    return <Counter name="queue" />;
  },
}));
vi.mock('../../../src/features/logs/index.ts', () => ({ LogPanel: () => <Counter name="log" /> }));
vi.mock('../../../src/app/StatusBar.tsx', () => ({ default: () => <span>status bar</span> }));

let failure: 'a' | 'b' | 'queue' | null = null;
// React deliberately rethrows render failures through the window in development.
// Suppress only these injected failures, leaving unexpected test errors visible.
function handleExpectedError(event: ErrorEvent) {
  if (/^(a render failed|b render failed|queue render failed|root failure)$/.test(event.message)) {
    event.preventDefault();
  }
}
beforeEach(() => window.addEventListener('error', handleExpectedError));
function Counter({ name }: { name: string }) {
  const [count, setCount] = useState(0);
  return (
    <button onClick={() => setCount(count + 1)}>
      {name}: {count}
    </button>
  );
}

function props(narrow = false): WorkspaceProps {
  const noop = () => {};
  return {
    effectivePaneOrientation: 'horizontal',
    showLocalPane: true,
    showRemotePane: true,
    panesRef: { current: null },
    splitRatio: 0.5,
    resizing: false,
    startResize: noop,
    resetSplitRatio: noop,
    renderPane: (id) => {
      if (failure === id) throw new Error(`${id} render failed`);
      return <Counter name={id} />;
    },
    dragMove: { startDrag: noop, cancelDrag: noop, ghostRef: { current: null }, dragInfo: null },
    statusBar: {
      status: 'idle',
      paneOrientation: 'horizontal',
      leftCount: 0,
      rightCount: 0,
      leftSelectedCount: 0,
      rightSelectedCount: 0,
      syncBrowsing: false,
      connectionVisualState: 'idle',
      logLineCount: 0,
      hasActiveTransfers: false,
      activeTransfersCount: 0,
      hasPausedTransfers: false,
    },
    transferLogSection: {
      windowNarrow: narrow,
      showTransferQueue: true,
      logEnabled: true,
      resizingSection: null,
      startSectionResize: () => noop,
      resetSectionHeight: () => noop,
      transferLogRef: { current: null },
      transferQueueHeight: 200,
      logPanelHeight: 200,
      transferManuallyResized: false,
      logManuallyResized: false,
      transferLogSplitRatio: 0.5,
      resizingTransferLog: false,
      startTransferLogResize: noop,
      resetTransferLogSplitRatio: noop,
      transfersEmpty: false,
      logEmpty: false,
      transfer: {
        onRetry: noop,
        onPause: noop,
        onStop: noop,
        onClearCompleted: noop,
        columnWidths: {},
        onColumnWidthsChange: noop,
        columnOrder: [],
        onColumnOrderChange: noop,
      },
      log: {
        lines: [],
        onClear: noop,
        activeConnectionIds: new Set(),
        connectionLabels: new Map(),
        showTimestamps: false,
        onToggleTimestamps: noop,
      },
    },
  };
}

afterEach(() => {
  window.removeEventListener('error', handleExpectedError);
  failure = null;
  vi.restoreAllMocks();
});

describe('workspace render failures', () => {
  test.each(['a', 'b', 'queue'] as const)(
    'isolates %s and retries without resetting siblings',
    (zone) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const workspace = props();
      const view = render(
        <ErrorBoundary>
          <Workspace {...workspace} />
        </ErrorBoundary>,
      );
      const siblings = ['a', 'b', 'queue', 'log'].filter((name) => name !== zone);
      for (const name of siblings)
        fireEvent.click(screen.getByRole('button', { name: `${name}: 0` }));
      failure = zone;
      view.rerender(
        <ErrorBoundary>
          <Workspace {...workspace} />
        </ErrorBoundary>,
      );
      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect(screen.queryByRole('button', { name: 'errorBoundary.reload' })).toBeNull();
      for (const name of siblings) {
        fireEvent.click(screen.getByRole('button', { name: `${name}: 1` }));
        expect(screen.getByRole('button', { name: `${name}: 2` })).toBeTruthy();
      }
      failure = null;
      fireEvent.click(screen.getByRole('button', { name: 'paneMenu.refresh' }));
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('button', { name: `${zone}: 0` })).toBeTruthy();
      for (const name of siblings)
        expect(screen.getByRole('button', { name: `${name}: 2` })).toBeTruthy();
    },
  );

  test('isolates the queue in narrow layout as well', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    failure = 'queue';
    render(<Workspace {...props(true)} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    for (const name of ['a', 'b', 'log']) {
      fireEvent.click(screen.getByRole('button', { name: `${name}: 0` }));
      expect(screen.getByRole('button', { name: `${name}: 1` })).toBeTruthy();
    }
  });

  test('retains the root fallback for failures outside local zones', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken(): never {
      throw new Error('root failure');
    }
    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('button', { name: 'errorBoundary.reload' })).toBeTruthy();
  });
});
