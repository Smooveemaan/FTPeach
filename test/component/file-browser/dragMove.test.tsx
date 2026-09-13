import { act, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useDragMove } from '../../../src/features/file-browser/components/useDragMove.ts';
import { resolveDropAction } from '../../../src/features/file-browser/components/dropAction.ts';
import { makePane } from '../../../src/features/file-browser/panes/paneModel.ts';
import { dropDestinationPath } from '../../../src/shared/paths.ts';

const source = {
  ...makePane('a', 'local'),
  path: 'C:\\work',
  entries: [{ name: 'folder', isDirectory: true, size: 0 }],
};
const target = { ...makePane('b', 'local'), path: 'C:\\other' };
const remote = {
  ...makePane('b', 'remote'),
  status: 'connected' as const,
  connectionId: 'session',
  path: '/remote',
};
const keys = { ctrlKey: false, shiftKey: false };
afterEach(() => {
  document.body.replaceChildren();
  document.body.classList.remove('drag-move-active');
});

test('default actions, modifiers and unsupported moves are consistent', () => {
  expect(resolveDropAction(source, target, null, ['folder'], keys)).toBe('move');
  expect(resolveDropAction(source, target, null, ['folder'], { ...keys, ctrlKey: true })).toBe(
    'copy',
  );
  expect(resolveDropAction(source, remote, 'child', ['folder'], keys)).toBe('copy');
  expect(resolveDropAction(remote, source, null, ['folder'], keys)).toBe('copy');
  expect(resolveDropAction(source, remote, null, ['folder'], { ...keys, shiftKey: true })).toBe(
    'invalid',
  );
  expect(resolveDropAction(remote, { ...remote, path: '/other' }, null, ['file'], keys)).toBe(
    'invalid',
  );
  expect(
    resolveDropAction(
      { ...remote, entries: source.entries },
      { ...remote, path: '/other' },
      null,
      ['folder'],
      keys,
    ),
  ).toBe('move');
  expect(
    resolveDropAction(remote, { ...remote, connectionId: 'other' }, null, ['folder'], keys),
  ).toBe('copy');
  expect(
    resolveDropAction(source, target, null, ['folder'], { ctrlKey: true, shiftKey: true }),
  ).toBe('invalid');
  expect(resolveDropAction(source, { ...remote, status: 'idle' }, null, ['folder'], keys)).toBe(
    'invalid',
  );
});

test('same directory, self and descendants are rejected across panes and breadcrumbs', () => {
  for (const path of ['c:\\WORK', 'C:\\work\\folder', 'C:\\work\\folder\\child']) {
    expect(resolveDropAction(source, target, path, ['folder'], keys)).toBe('invalid');
  }
  expect(resolveDropAction(source, source, 'C:\\', ['folder'], keys)).toBe('move');
  expect(dropDestinationPath('remote', '/a/b', '/a')).toBe('/a');
  expect(dropDestinationPath('local', 'C:\\a\\b', 'C:\\a')).toBe('C:\\a');
});

function start() {
  document.body.innerHTML =
    '<div class="pane" data-side="a"><div class="pane-list" data-side="a"><div class="row" data-name="folder"></div></div><span data-drop-path="C:\\">root</span></div><div class="pane" data-side="b"><span data-drop-path="C:\\other">other</span></div>';
  const drop = vi.fn();
  const hook = renderHook(() =>
    useDragMove(drop, {
      resolveAction: (a, b, folder, names, modifiers) =>
        resolveDropAction(
          a === 'a' ? source : target,
          b === 'a' ? source : target,
          folder,
          names,
          modifiers,
        ),
    }),
  );
  act(() =>
    hook.result.current.startDrag('a', ['folder'], { name: 'folder', isDirectory: true }, {
      button: 0,
      clientX: 0,
      clientY: 0,
    } as ReactMouseEvent),
  );
  const crumb = document.querySelector<HTMLElement>('[data-side="b"] [data-drop-path]')!;
  fireEvent.mouseMove(crumb, { clientX: 40, clientY: 40 });
  return { ...hook, drop, crumb };
}

test('breadcrumb highlights, modifier updates without moving, and drop uses Copy', () => {
  const { result, crumb, drop } = start();
  expect(result.current.dragInfo?.action).toBe('move');
  expect(crumb.classList.contains('drag-target')).toBe(true);
  expect(document.querySelector('.drag-source-row')).toBeNull();
  fireEvent.keyDown(document, { key: 'Control', ctrlKey: true });
  expect(result.current.dragInfo?.action).toBe('copy');
  fireEvent.mouseUp(crumb, { ctrlKey: true });
  expect(drop).toHaveBeenCalledWith(
    expect.objectContaining({ targetFolder: 'C:\\other', isMove: false }),
  );
  expect(crumb.classList.contains('drag-target')).toBe(false);
});

test('invalid modifiers clear highlight and never submit a drop', () => {
  const { result, crumb, drop } = start();
  fireEvent.keyDown(document, { key: 'Shift', ctrlKey: true, shiftKey: true });
  expect(result.current.dragInfo?.action).toBe('invalid');
  expect(crumb.classList.contains('drag-target')).toBe(false);
  fireEvent.mouseUp(crumb, { ctrlKey: true, shiftKey: true });
  expect(drop).not.toHaveBeenCalled();
});

test('own background has no action and Escape clears the address highlight', () => {
  const { result, crumb, drop } = start();
  fireEvent.mouseMove(document.querySelector('.pane-list')!, { clientX: 40, clientY: 40 });
  expect(result.current.dragInfo?.action).toBeNull();
  fireEvent.mouseMove(crumb, { clientX: 40, clientY: 40 });
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(result.current.dragInfo).toBeNull();
  expect(crumb.classList.contains('drag-target')).toBe(false);
  expect(drop).not.toHaveBeenCalled();
});
