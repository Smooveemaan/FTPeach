import { renderHook } from '@testing-library/react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import useFileSelection from '../../../src/features/file-browser/components/useFileSelection.ts';
import type { FileEntry } from '../../../src/shared/types.ts';

const entries: FileEntry[] = [{ name: 'a.txt', isDirectory: false }];

afterEach(() => {
  document.body.innerHTML = '';
});

function startDrag() {
  const list = document.createElement('div');
  list.className = 'pane-list';
  list.dataset.side = 'a';
  list.setPointerCapture = vi.fn();
  list.hasPointerCapture = () => false;
  list.releasePointerCapture = vi.fn();
  document.body.append(list);
  const onSelectionChange = vi.fn();
  const hook = renderHook(() =>
    useFileSelection({
      entries,
      sorted: entries,
      selectedNames: new Set(),
      onSelectionChange,
      isVirtualized: false,
      listRef: { current: null },
      side: 'a',
    }),
  );
  hook.result.current.startMarquee({
    button: 0,
    target: list,
    currentTarget: list,
    clientX: 0,
    clientY: 0,
    pointerId: 1,
    ctrlKey: false,
    metaKey: false,
  } as unknown as ReactPointerEvent<HTMLDivElement>);
  const move = () =>
    list.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 50, clientY: 50 }));
  return { list, hook, onSelectionChange, move };
}

test('a drag whose pointer capture is lost stops following the pointer', () => {
  const { list, onSelectionChange, move } = startDrag();
  list.dispatchEvent(new Event('lostpointercapture'));
  move();
  list.dispatchEvent(new Event('pointerup'));
  expect(onSelectionChange).not.toHaveBeenCalled();
});

test('a pane unmounted mid-drag stops the drag', () => {
  const { hook, onSelectionChange, move } = startDrag();
  hook.unmount();
  move();
  expect(onSelectionChange).not.toHaveBeenCalled();
});

test('a cancelled pointer does not clear the selection the way a click would', () => {
  const { list, onSelectionChange } = startDrag();
  list.dispatchEvent(new Event('pointercancel'));
  expect(onSelectionChange).not.toHaveBeenCalled();
  list.dispatchEvent(new Event('pointerup'));
  expect(onSelectionChange).not.toHaveBeenCalled();
});
