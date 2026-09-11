import { renderHook } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { useRememberedConnectionLabels } from '../../../src/features/logs/useRememberedConnectionLabels.ts';

beforeEach(() => sessionStorage.clear());

test('a closed connection keeps its label, and nothing new keeps the same map', () => {
  const { result, rerender } = renderHook(({ labels }) => useRememberedConnectionLabels(labels), {
    initialProps: {
      labels: new Map<string | null, string>([
        ['one', 'Work server'],
        [null, 'ignored'],
      ]),
    },
  });
  const first = result.current;
  expect([...first]).toEqual([['one', 'Work server']]);

  rerender({ labels: new Map([['one', 'Work server']]) });
  expect(result.current).toBe(first);

  // The first connection closes and another opens.
  rerender({ labels: new Map([['two', 'Home NAS']]) });
  expect(result.current.get('one')).toBe('Work server');
  expect(result.current.get('two')).toBe('Home NAS');

  rerender({ labels: new Map([['two', 'Home NAS (left)']]) });
  expect(result.current.get('two')).toBe('Home NAS (left)');
});

test('labels outlive a reload of the interface', () => {
  const before = renderHook(() => useRememberedConnectionLabels(new Map([['one', 'Work server']])));
  before.unmount();

  const after = renderHook(() => useRememberedConnectionLabels(new Map()));
  expect(after.result.current.get('one')).toBe('Work server');
});

test('unreadable storage starts empty', () => {
  sessionStorage.setItem('ftpeach.logConnectionLabels', '{broken');
  const { result } = renderHook(() => useRememberedConnectionLabels(new Map()));
  expect(result.current.size).toBe(0);
});
