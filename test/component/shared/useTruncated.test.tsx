import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useTruncated } from '../../../src/hooks/useTruncated.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test.each([
  ['fits exactly', 10, 110, 100, false],
  ['fits with layout rounding noise', 10, 110.015625, 100, false],
  ['fits with rounded integer scroll metrics', 10, 110, 101, false],
  ['clips an eighth of a pixel', 10, 110.125, 100, true],
  ['clips a fraction on the right', 10, 110.25, 100, true],
  ['clips a fraction on the left', 9.75, 110, 100, true],
  ['overflows by one integer pixel', 10, 111, 101, true],
] as const)('%s', (_, left, right, scrollWidth, expected) => {
  const element = document.createElement('div');
  element.innerHTML = '<bdi>Desktop</bdi><span aria-hidden="true"></span>';
  Object.defineProperties(element, {
    scrollWidth: { value: scrollWidth },
    clientWidth: { value: 100 },
  });
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 0, 100, 16));
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(left, 0, right - left, 16),
  );
  const { result, rerender } = renderHook(({ tick }) => useTruncated([tick]), {
    initialProps: { tick: 0 },
  });
  result.current[0].current = element;
  rerender({ tick: 1 });
  expect(result.current[1]).toBe(expected);
});

test('resize bursts defer text measurements and unmount cancels pending work', () => {
  vi.useFakeTimers();
  let resize!: () => void;
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
  const element = document.createElement('div');
  element.textContent = 'Desktop';
  Object.defineProperties(element, {
    scrollWidth: { value: 100 },
    clientWidth: { value: 100 },
  });
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 16));
  const measure = vi.spyOn(Range.prototype, 'getBoundingClientRect');
  measure.mockReturnValue(new DOMRect(0, 0, 80, 16));
  const { result, rerender, unmount } = renderHook(({ tick }) => useTruncated([tick]), {
    initialProps: { tick: 0 },
  });
  result.current[0].current = element;
  rerender({ tick: 1 });
  expect(result.current[1]).toBe(false);
  measure.mockClear();
  measure.mockReturnValue(new DOMRect(0, 0, 100.25, 16));

  for (let index = 0; index < 10; index += 1) {
    act(() => {
      resize();
      vi.advanceTimersByTime(50);
    });
  }
  expect(measure).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(50));
  expect(measure).toHaveBeenCalledTimes(1);
  expect(result.current[1]).toBe(true);

  act(() => resize());
  measure.mockReturnValue(new DOMRect(0, 0, 80, 16));
  rerender({ tick: 2 });
  expect(result.current[1]).toBe(false);
  measure.mockClear();
  act(() => {
    resize();
  });
  unmount();
  act(() => vi.advanceTimersByTime(100));
  expect(measure).not.toHaveBeenCalled();
});
