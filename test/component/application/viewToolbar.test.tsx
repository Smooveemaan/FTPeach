import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import ViewToolbar from '../../../src/app/ViewToolbar.tsx';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

function renderToolbar(vault: { configured: boolean; locked: boolean } | null) {
  const toggleVault = vi.fn();
  const noop = () => undefined;
  const view = render(
    <ViewToolbar
      showLocalPane
      toggleLocalPane={noop}
      showRemotePane
      toggleRemotePane={noop}
      showTransferQueue
      toggleTransferQueue={noop}
      logEnabled={false}
      toggleLog={noop}
      effectivePaneOrientation="horizontal"
      paneOrientation="horizontal"
      windowNarrow={false}
      togglePaneOrientation={noop}
      hasActiveTransfers={false}
      hasPausedTransfers={false}
      hasPausableTransfers={false}
      canResumeAllTransfers={false}
      pauseAllTransfers={noop}
      resumeAllTransfers={noop}
      hasRetryableTransfers={false}
      stopAllTransfers={noop}
      retryAllTransfers={noop}
      refreshBothPanes={noop}
      vault={vault}
      toggleVault={toggleVault}
    />,
  );
  return { ...view, toggleVault };
}

test('the vault lock shows once a master password is set, and says what a click does', () => {
  renderToolbar(null).unmount();
  expect(screen.queryByRole('button', { name: /Vault$/ })).toBeNull();
  renderToolbar({ configured: false, locked: true }).unmount();
  expect(screen.queryByRole('button', { name: /Vault$/ })).toBeNull();

  const locked = renderToolbar({ configured: true, locked: true });
  fireEvent.click(screen.getByRole('button', { name: 'viewToolbar.unlockVault' }));
  expect(locked.toggleVault).toHaveBeenCalledOnce();
  locked.unmount();

  renderToolbar({ configured: true, locked: false });
  expect(screen.getByRole('button', { name: 'viewToolbar.lockVault' }).className).toContain(
    'is-unlocked',
  );
});
