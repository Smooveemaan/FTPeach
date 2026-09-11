// Native WebView zoom keeps pointer, viewport and authored CSS coordinates
// aligned, so menu placement uses raw viewport values at every preference.
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import ContextMenu from '../../../src/components/ContextMenu.tsx';
import { applyInterfaceScale } from '../../../src/platform/interfaceScale.ts';

const ITEMS = [{ label: 'One', onClick: () => {} }];

function setViewport(width: number, height: number): void {
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('innerHeight', height);
}

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty('--interface-scale');
  delete document.documentElement.dataset.interfaceScale;
  vi.unstubAllGlobals();
});

function menuStyle(container: HTMLElement): CSSStyleDeclaration {
  const menu = container.querySelector<HTMLElement>('.context-menu');
  if (!menu) throw new Error('Context menu was not rendered.');
  return menu.style;
}

describe('ContextMenu scale-aware positioning', () => {
  test('at 100% scale, position matches the raw click coordinates', () => {
    setViewport(1000, 800);
    const { container } = render(<ContextMenu x={100} y={120} items={ITEMS} onClose={() => {}} />);
    const style = menuStyle(container);
    expect(style.left).toBe('100px');
    expect(style.top).toBe('120px');
  });

  test('at 150% native scale, position remains in viewport coordinates', async () => {
    setViewport(1000, 800);
    await applyInterfaceScale(150);
    const { container } = render(<ContextMenu x={300} y={300} items={ITEMS} onClose={() => {}} />);
    const style = menuStyle(container);
    expect(style.left).toBe('300px');
    expect(style.top).toBe('300px');
  });

  test('at 150% native scale, edge clamping uses viewport coordinates', async () => {
    setViewport(1000, 800);
    await applyInterfaceScale(150);
    const { container } = render(<ContextMenu x={990} y={790} items={ITEMS} onClose={() => {}} />);
    const style = menuStyle(container);
    const localWidth = 1000;
    const localHeight = 800;
    expect(parseFloat(style.left)).toBeCloseTo(localWidth - 220, 5);
    expect(parseFloat(style.top)).toBeCloseTo(localHeight - ITEMS.length * 28 - 40, 5);
  });

  test('a button menu without room below opens upward from the button', () => {
    setViewport(1000, 800);
    const { container } = render(
      <ContextMenu x={100} y={782} aboveY={756} items={ITEMS} onClose={() => {}} />,
    );
    const style = menuStyle(container);
    expect(style.top).toBe('');
    expect(style.bottom).toBe(`${800 - 756}px`);
  });

  test('a button menu with room below still opens downward', () => {
    setViewport(1000, 800);
    const { container } = render(
      <ContextMenu x={100} y={120} aboveY={94} items={ITEMS} onClose={() => {}} />,
    );
    expect(menuStyle(container).top).toBe('120px');
  });
});
