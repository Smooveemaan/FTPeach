import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { DndContextProps, Modifier } from '@dnd-kit/core';

import TabStrip from '../../../src/features/file-browser/TabStrip.tsx';
import { makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';

const drag = vi.hoisted(() => ({ modifier: undefined as Modifier | undefined }));
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: (props: DndContextProps) => {
      drag.modifier = props.modifiers?.[0];
      return React.createElement(actual.DndContext, props);
    },
  };
});

afterEach(() => {
  document.documentElement.style.removeProperty('--interface-scale');
  document.documentElement.dir = '';
});

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

test('typing a tab name does not reselect and replace each previous character', async () => {
  const user = userEvent.setup();
  const onRename = vi.fn();
  const tab = { ...makeTab('tab-1'), name: 'Original' };

  render(
    <TabStrip
      tabs={[tab]}
      activeTabId={tab.id}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onNew={vi.fn()}
      onRename={onRename}
    />,
  );

  await user.pointer({ target: screen.getByRole('tab'), keys: '[MouseRight]' });
  const input = screen.getByRole('textbox', { name: 'tabStrip.rename' });
  await user.clear(input);
  await user.type(input, 'Renamed{Enter}');

  expect(onRename).toHaveBeenCalledWith('tab-1', 'Renamed');
});

test.each([
  ['ltr', 1, 0],
  ['ltr', 1.5, 120],
  ['rtl', 1, 0],
  ['rtl', 1.5, -120],
] as const)(
  'tab drag respects the left inset in %s at scale %s and scroll %s',
  (direction, scale, scrollLeft) => {
    document.documentElement.dir = direction;
    document.documentElement.style.setProperty('--interface-scale', String(scale));
    const tab = makeTab('tab-1');
    render(
      <TabStrip
        tabs={[tab]}
        activeTabId={tab.id}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onNew={vi.fn()}
      />,
    );
    const strip = screen.getByRole('tablist');
    strip.style.paddingLeft = '10px';
    strip.scrollLeft = scrollLeft;
    Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: 800 });
    vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 0, 400, 40));
    const args: Parameters<Modifier>[0] = {
      activatorEvent: null,
      active: null,
      draggingNodeRect: null,
      containerNodeRect: null,
      over: null,
      overlayNodeRect: null,
      scrollableAncestors: [],
      scrollableAncestorRects: [],
      windowRect: null,
      activeNodeRect: new DOMRect(200, 0, 100, 40),
      transform: { x: -1000, y: 100, scaleX: 1, scaleY: 1 },
    };
    const bounded = drag.modifier!(args);
    expect(200 + bounded.x).toBe(50 + 10 * scale);
    expect(bounded.y).toBe(0);
    expect(drag.modifier!({ ...args, transform: { ...args.transform, x: -20 } }).x).toBe(-20);
  },
);
