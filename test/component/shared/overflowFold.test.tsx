import { useRef } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useOverflowFold } from '../../../src/hooks/useOverflowFold.ts';

let resize: (_width: number) => void;
const renders = vi.fn();
const subscriptions = vi.fn();

beforeEach(() => {
  renders.mockClear();
  subscriptions.mockClear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ConstructorParameters<typeof ResizeObserver>[0]) {
        subscriptions();
        resize = (width) => callback([{ contentRect: { width } } as ResizeObserverEntry], this);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => vi.unstubAllGlobals());

function Toolbar({ baseWidth = 32 }: { baseWidth?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { foldedKeys } = useOverflowFold({
    containerRef,
    baseWidth,
    foldOrder: [
      { key: 'copy', width: 32 },
      { key: 'home', width: 32 },
    ],
  });
  renders();
  return (
    <div ref={containerRef} data-testid="toolbar">
      {[...foldedKeys].join(',')}
    </div>
  );
}

test('resizing within a folding interval does not render the toolbar', () => {
  render(<Toolbar />);
  const initial = renders.mock.calls.length;
  for (const width of [200, 150, 100, 90]) act(() => resize(width));
  expect(renders).toHaveBeenCalledTimes(initial);

  act(() => resize(89));
  expect(screen.getByTestId('toolbar').textContent).toBe('copy,home');
  const folded = renders.mock.calls.length;
  for (const width of [80, 60, 85, 89]) act(() => resize(width));
  expect(renders).toHaveBeenCalledTimes(folded);

  act(() => resize(90));
  expect(screen.getByTestId('toolbar').textContent).toBe('');
  expect(subscriptions).toHaveBeenCalledTimes(1);
});

test('changed button geometry recalculates folding without a resize', () => {
  const { rerender } = render(<Toolbar />);
  act(() => resize(80));
  expect(screen.getByTestId('toolbar').textContent).toBe('copy,home');
  rerender(<Toolbar baseWidth={0} />);
  expect(screen.getByTestId('toolbar').textContent).toBe('');
  expect(subscriptions).toHaveBeenCalledTimes(1);
});
