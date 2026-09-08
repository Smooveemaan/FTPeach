import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useMenuPosition } from '../../../src/hooks/useMenuPosition.ts';

vi.mock('../../../src/platform/interfaceScale.ts', () => ({ getInterfaceScale: () => scale }));
let scale = 1;
const grid = { count: 9, columns: 3, cell: 30, gap: 4, padding: 5, maxRows: 3, scrollbarWidth: 0 };

afterEach(() => {
  document.documentElement.dir = '';
  scale = 1;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function anchor(left: number, right: number, bottom: number) {
  const element = document.createElement('button');
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ left, right, bottom } as DOMRect);
  return { current: element };
}

describe('appearance menu position', () => {
  test.each(['ltr', 'rtl'])('clamps both viewport edges in %s', (direction) => {
    document.documentElement.dir = direction;
    const { result, rerender } = renderHook(({ trigger }) => useMenuPosition(trigger, true, grid), {
      initialProps: { trigger: anchor(-50, -20, -10) },
    });
    expect(result.current).toEqual({ left: 8, top: 8 });
    rerender({
      trigger: anchor(window.innerWidth + 20, window.innerWidth + 50, window.innerHeight),
    });
    expect(result.current).toEqual({
      left: window.innerWidth - 116,
      top: window.innerHeight - 116,
    });
  });

  test.each(['ltr', 'rtl'])('aligns the anchor at 150 percent scale in %s', (direction) => {
    scale = 1.5;
    document.documentElement.dir = direction;
    const trigger = anchor(300, 345, 148);
    const { result } = renderHook(() => useMenuPosition(trigger, true, grid));
    expect(result.current).toEqual({ left: direction === 'rtl' ? 122 : 200, top: 100 });
  });

  test('repositions after resize and clears the position when closed', () => {
    const trigger = anchor(900, 930, 700);
    const { result, rerender, unmount } = renderHook(
      ({ open }) => useMenuPosition(trigger, open, grid),
      {
        initialProps: { open: true },
      },
    );
    const remove = vi.spyOn(window, 'removeEventListener');
    vi.stubGlobal('innerWidth', 200);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(result.current?.left).toBe(84);
    rerender({ open: false });
    expect(result.current).toBeNull();
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
    unmount();
  });

  test('accounts for scrolling grids and viewports smaller than the menu', () => {
    vi.stubGlobal('innerWidth', 100);
    vi.stubGlobal('innerHeight', 90);
    const trigger = anchor(80, 100, 80);
    const { result } = renderHook(() =>
      useMenuPosition(trigger, true, { ...grid, count: 20, scrollbarWidth: 10 }),
    );
    expect(result.current).toEqual({ left: 8, top: 8 });
  });
});
