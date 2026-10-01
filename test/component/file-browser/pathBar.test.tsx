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

test('the ellipsis of a path that does not fit opens the nearest folder it hides', () => {
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
  expect(onCrumbClick).toHaveBeenCalledExactlyOnceWith('/a/b/c');
  // The click belongs to the crumb: the bar does not turn into the path field.
  expect(screen.queryByRole('textbox')).toBeNull();
});
