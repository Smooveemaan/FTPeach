import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import StatusBar from '../../../src/app/StatusBar.tsx';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

function renderBar(narrow: boolean, notice: string) {
  return render(barElement(narrow, notice));
}

function barElement(narrow: boolean, notice: string) {
  return (
    <StatusBar
      status={{} as never}
      paneOrientation="horizontal"
      leftCount={3}
      rightCount={4}
      leftSelectedCount={0}
      rightSelectedCount={0}
      syncBrowsing={false}
      connectionVisualState="idle"
      logLineCount={0}
      hasActiveTransfers={false}
      activeTransfersCount={0}
      hasPausedTransfers={false}
      narrow={narrow}
      update={<span className="status-update">v2.0.0</span>}
      notice={notice ? { text: notice, short: notice, id: 1 } : undefined}
    />
  );
}

test.each([
  [false, 'Imported', false],
  [false, '', true],
  [true, '', true],
  [true, 'Imported', false],
])(
  'narrow=%s notice=%j keeps the connection status, transfers, update and pane counts: %s',
  (narrow, notice, shown) => {
    renderBar(narrow, notice);
    expect(screen.getByRole('status').textContent).toBe(notice.repeat(2));
    expect(screen.queryByText('statusBar.status.disconnected') !== null).toBe(shown);
    expect(screen.queryByText('statusBar.leftCount') !== null).toBe(shown);
    expect(screen.queryByText('statusBar.transfers') !== null).toBe(shown);
    expect(screen.queryByText('v2.0.0') !== null).toBe(shown);
  },
);

test('a message fades the status out, takes its place, and fades it back in', () => {
  const view = renderBar(false, '');
  const bar = () => view.container.querySelector('.status-bar')!;
  const statusText = () => screen.queryByText('statusBar.status.disconnected');
  // jsdom has no AnimationEvent, so React listens for the prefixed name there.
  const finishFade = () =>
    fireEvent(statusText()!, new Event('webkitAnimationEnd', { bubbles: true }));
  expect(bar().className).toBe('status-bar');

  view.rerender(barElement(false, 'Imported'));
  expect(bar().className).toBe('status-bar is-leaving');
  expect(screen.getByRole('status').textContent).toBe('');
  finishFade();
  expect(bar().className).toBe('status-bar is-notice');
  expect(statusText()).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('ImportedImported');

  view.rerender(barElement(false, ''));
  expect(bar().className).toBe('status-bar is-returning');
  expect(statusText()).not.toBeNull();
  finishFade();
  expect(bar().className).toBe('status-bar');
});
