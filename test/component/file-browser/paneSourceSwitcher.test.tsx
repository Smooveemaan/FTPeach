import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import PaneSourceSwitcher from '../../../src/features/file-browser/components/PaneSourceSwitcher.tsx';
import { initialForm } from '../../../src/features/file-browser/panes/paneModel.ts';
import type { PaneKind } from '../../../src/shared/paneContracts.ts';

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
