import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import PaneSourceSwitcher from '../../../src/features/file-browser/components/PaneSourceSwitcher.tsx';
import { initialForm } from '../../../src/features/file-browser/panes/paneModel.ts';
import type { PaneKind } from '../../../src/shared/paneContracts.ts';
import type { ComponentProps } from 'react';

function sourceProps(): ComponentProps<typeof PaneSourceSwitcher> {
  return {
    pane: {
      kind: 'remote',
      status: 'connected',
      siteLabel: 'Server',
      siteId: null,
      form: { ...initialForm, host: 'example.org', protocol: 'sftp', port: '2222' },
      errorMessage: '',
      sshFingerprint: 'abcdef',
    },
    orderedSites: [],
    localPaths: [],
    formatDate: () => '',
    onSwitchLocal: vi.fn(),
    onStartConnect: vi.fn(),
    onFormChange: vi.fn(),
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onCancelConnect: vi.fn(),
    onDismissError: vi.fn(),
    onSiteConnect: vi.fn(),
    onLocalPathOpen: vi.fn(),
    onSaveSite: vi.fn(),
    onOpenSiteManager: vi.fn(),
    onOpenLocalPathManager: vi.fn(),
  };
}

test('right click offers connection actions and copies the address and verified SSH fingerprint', () => {
  const props = sourceProps();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  try {
    const { container } = render(<PaneSourceSwitcher {...props} />);
    const source = container.querySelector<HTMLButtonElement>('.pane-source')!;
    fireEvent.contextMenu(source);
    expect(screen.queryByText('paneSourceSwitcher.connectToServer')).toBeNull();
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'paneSourceSwitcher.copyConnectionAddress' }),
    );
    expect(writeText).toHaveBeenLastCalledWith('example.org:2222');
    fireEvent.contextMenu(source);
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'paneSourceSwitcher.copySshFingerprint' }),
    );
    expect(writeText).toHaveBeenLastCalledWith('abcdef');
    fireEvent.contextMenu(source);
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'connectionBar.connectTooltip.disconnect' }),
    );
    expect(props.onDisconnect).toHaveBeenCalledOnce();
    expect(props.onConnect).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

test('a disconnected server offers connect and hides an unavailable fingerprint', () => {
  const props = sourceProps();
  props.pane = { ...props.pane, status: 'idle', sshFingerprint: undefined };
  const { container } = render(<PaneSourceSwitcher {...props} />);
  fireEvent.contextMenu(container.querySelector('.pane-source')!);
  expect(
    screen.queryByRole('menuitem', { name: 'paneSourceSwitcher.copySshFingerprint' }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('menuitem', { name: 'connectionBar.connectTooltip.connect' }));
  expect(props.onConnect).toHaveBeenCalledOnce();
  expect(props.onDisconnect).not.toHaveBeenCalled();
});

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

test('the source selector opens a server form and returns to the computer', () => {
  const connect = vi.fn();
  function Pane() {
    const [kind, setKind] = useState<PaneKind>('local');
    const [form, setForm] = useState(initialForm);
    return (
      <PaneSourceSwitcher
        pane={{ kind, status: 'idle', siteLabel: '', siteId: null, form, errorMessage: '' }}
        orderedSites={[]}
        localPaths={[]}
        formatDate={() => ''}
        onSwitchLocal={() => setKind('local')}
        onStartConnect={() => setKind('remote')}
        onFormChange={setForm}
        onConnect={() => connect(form)}
        onDisconnect={vi.fn()}
        onCancelConnect={vi.fn()}
        onDismissError={vi.fn()}
        onSiteConnect={vi.fn()}
        onLocalPathOpen={vi.fn()}
        onSaveSite={vi.fn()}
        onOpenSiteManager={vi.fn()}
        onOpenLocalPathManager={vi.fn()}
      />
    );
  }
  render(<Pane />);
  expect(screen.queryByLabelText('connectionBar.fields.address')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /paneSourceSwitcher\.local/ }));
  fireEvent.click(screen.getByText('paneSourceSwitcher.connectToServer'));
  fireEvent.change(screen.getByLabelText('connectionBar.fields.address'), {
    target: { value: 'files.example.com' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'connectionBar.connectTooltip.connect' }));
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({ host: 'files.example.com' }));
  fireEvent.click(screen.getByRole('button', { name: /paneSourceSwitcher\.remote/ }));
  fireEvent.click(screen.getByText('paneSourceSwitcher.local'));
  expect(screen.queryByLabelText('connectionBar.fields.address')).toBeNull();
  expect(screen.getByRole('button', { name: /paneSourceSwitcher\.local/ })).toBeTruthy();
});
