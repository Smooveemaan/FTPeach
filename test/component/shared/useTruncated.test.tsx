import { renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useTruncated } from '../../../src/hooks/useTruncated.ts';

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
