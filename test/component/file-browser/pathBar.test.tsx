import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import PathBar from '../../../src/features/file-browser/components/PathBar.tsx';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => vi.restoreAllMocks());

const crumbs = ['/', '/a', '/a/b', '/a/b/c', '/a/b/c/d'].map((path) => ({
  path,
  label: path.split('/').at(-1) || '/',
}));

test('the ellipsis of a path that does not fit lists the folders it hides, nearest first', () => {
  // jsdom lays nothing out: every crumb and separator is 100 wide in a bar of 350,
  // which leaves room for the root, the ellipsis and the last folder.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100,
  } as DOMRect);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(350);
  const onCrumbClick = vi.fn();
  const onPathSubmit = vi.fn();
  render(
    <PathBar
      kind="remote"
      crumbs={crumbs}
      onCrumbClick={onCrumbClick}
      onPathSubmit={onPathSubmit}
    />,
  );

  const shown = [...document.querySelectorAll('.pane-path:not(.pane-path-measure) > .crumb')];
  expect(shown.map((crumb) => crumb.textContent)).toEqual(['/', '…', 'd']);
  fireEvent.click(shown[1]!);
  const items = screen.getAllByRole('menuitem');
  expect(items.map((item) => item.textContent)).toEqual(['c', 'b', 'a']);
  // The Move to list: the nearest folder takes focus, arrows move on.
  expect(document.activeElement).toBe(items[0]);
  fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(items[1]);
  fireEvent.click(items[1]!);
  expect(onCrumbClick).toHaveBeenCalledExactlyOnceWith('/a/b');
  expect(screen.queryByRole('menu')).toBeNull();
  // The click belongs to the crumb: the bar does not turn into the path field.
  expect(screen.queryByRole('textbox')).toBeNull();
});

test('the path field hands the keys to the list on Enter and back to the bar on Escape', () => {
  const onPathSubmit = vi.fn();
  render(
    <div className="pane" tabIndex={0}>
      <PathBar kind="local" crumbs={crumbs} onCrumbClick={vi.fn()} onPathSubmit={onPathSubmit} />
    </div>,
  );
  const bar = screen.getByRole('button', { name: 'filePane.editPathAriaLabel' });

  fireEvent.keyDown(bar, { key: 'Enter' });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '/a/b' } });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(onPathSubmit).toHaveBeenCalledExactlyOnceWith('/a/b');
  expect(document.activeElement).toBe(document.querySelector('.pane'));

  fireEvent.keyDown(bar, { key: 'Enter' });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(document.activeElement).toBe(bar);
  expect(onPathSubmit).toHaveBeenCalledOnce();
});
