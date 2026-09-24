import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ToolbarOverflowMenu from '../../../src/components/ToolbarOverflowMenu.tsx';
import { placeBelowAnchor, useMenuPosition } from '../../../src/hooks/useMenuPosition.ts';

vi.mock('../../../src/platform/interfaceScale.ts', () => ({ getInterfaceScale: () => scale }));
let scale = 1;
const grid = { count: 9, columns: 3, cell: 30, gap: 4, padding: 5, maxRows: 3, scrollbarWidth: 0 };

afterEach(() => {
  cleanup();
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

describe('overlay placement below an anchor', () => {
  const box = { gap: 2, margin: 8 };
  const viewport = (scale: number, rtl: boolean) => ({ width: 1200, height: 900, scale, rtl });

  test.each([1, 1.5, 2])('follows the anchor at scale %s in both directions', (scale) => {
    const rect = { left: 300 * scale, right: 360 * scale, bottom: 100 * scale };
    expect(placeBelowAnchor(rect, viewport(scale, false), box)).toEqual({
      top: 100 + 2 / scale,
      inlineStart: 300,
    });
    expect(placeBelowAnchor(rect, viewport(scale, true), box)).toEqual({
      top: 100 + 2 / scale,
      inlineStart: 1200 / scale - 360,
    });
  });

  test.each([false, true])('keeps a known box inside the bottom and side edges (rtl %s)', (rtl) => {
    const rect = { left: 1190, right: 1190, bottom: 890 };
    const placed = placeBelowAnchor(rect, viewport(1, rtl), { ...box, width: 200, height: 150 });
    expect(placed.top).toBe(900 - 150 - 8);
    expect(placed.inlineStart).toBe(rtl ? 10 : 1200 - 200 - 8);
  });

  test('an unknown size only keeps the start edges in the viewport', () => {
    expect(
      placeBelowAnchor({ left: -40, right: 1300, bottom: 890 }, viewport(1, false), box),
    ).toEqual({
      top: 892,
      inlineStart: 8,
    });
  });
});

describe('toolbar overflow menu', () => {
  test('reopening after a resize places the menu from the new viewport', () => {
    render(<ToolbarOverflowMenu items={[{ label: 'One', onClick: () => {} }]} />);
    const trigger = screen.getByRole('button');
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      left: 50,
      right: 80,
      bottom: 580,
    } as DOMRect);
    const menuTop = () => document.querySelector<HTMLElement>('.toolbar-overflow-menu')?.style.top;
    vi.stubGlobal('innerHeight', 800);
    fireEvent.click(trigger);
    expect(menuTop()).toBe('582px');
    fireEvent.click(trigger);
    vi.stubGlobal('innerHeight', 600);
    fireEvent.click(trigger);
    expect(menuTop()).toBe('532px');
  });
});
