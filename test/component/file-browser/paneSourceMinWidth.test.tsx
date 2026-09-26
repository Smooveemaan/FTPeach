/* eslint no-unused-vars: ["warn", { "argsIgnorePattern": "^_|^this$" }] -- TypeScript receiver annotations are not runtime arguments. */
import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { usePaneSourceMinWidth } from '../../../src/features/file-browser/components/PaneTitleBar.tsx';

afterEach(() => vi.unstubAllGlobals());

test('stretching a disconnected form does not render its pane unless the minimum changes', () => {
  let width = 500;
  let fixedWidth = 200;
  let resize!: () => void;
  const renders = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, width, 30),
  );
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('field-host') ? width - fixedWidth : width;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => width - 28);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width - 28);

  function Pane() {
    const { sourceRef, paneStyle } = usePaneSourceMinWidth({ disconnected: true });
    renders();
    return (
      <div className="pane" style={paneStyle} data-testid="pane">
        <section ref={sourceRef}>
          <div className="connection-row">
            <input className="field-host" style={{ minWidth: 56 }} />
          </div>
        </section>
      </div>
    );
  }

  render(<Pane />);
  act(() => resize());
  expect(screen.getByTestId('pane').style.minWidth).toBe('256px');
  const initial = renders.mock.calls.length;
  for (const nextWidth of [600, 450, 800, 350]) {
    act(() => {
      width = nextWidth;
      resize();
    });
  }
  expect(renders).toHaveBeenCalledTimes(initial);
  act(() => {
    fixedWidth = 230;
    resize();
  });
  expect(screen.getByTestId('pane').style.minWidth).toBe('286px');
  expect(renders.mock.calls.length).toBeGreaterThan(initial);
});
