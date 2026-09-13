import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import Modal from '../../../src/components/Modal.tsx';
import PromptDialog from '../../../src/components/PromptDialog.tsx';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('critical dialog accessibility', () => {
  beforeEach(() => document.body.replaceChildren());

  test('labels the dialog, traps Tab, closes with Escape and restores focus', async () => {
    const user = userEvent.setup();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const view = render(
      <Modal title="Delete file" onClose={onClose} footer={<button>Confirm</button>}>
        <button>First</button>
      </Modal>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Delete file' });
    expect(dialog).toHaveProperty('ariaModal', 'true');
    // Autofocus deliberately skips the header close (X) button so Enter reaches
    // the dialog's own content instead of dismissing it; the focus trap still
    // wraps round to that button on Tab, which the next assertion covers.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
    screen.getByText('Confirm').focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'common.close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();

    view.unmount();
    expect(document.activeElement).toBe(opener);
  });

  test('Escape closes only the dialog opened last', () => {
    const lower = vi.fn();
    const upper = vi.fn();
    const tree = (showUpper: boolean) => (
      <>
        <Modal title="Lower" onClose={lower}>
          <button>Lower</button>
        </Modal>
        {showUpper && (
          <Modal title="Upper" onClose={upper}>
            <button>Upper</button>
          </Modal>
        )}
      </>
    );
    const view = render(tree(true));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(upper).toHaveBeenCalledOnce();
    expect(lower).not.toHaveBeenCalled();

    view.rerender(tree(false));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(lower).toHaveBeenCalledOnce();
    view.unmount();
  });

  test('prompt trims input and submits from the keyboard', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(
      <PromptDialog
        title="Rename"
        label="Name"
        defaultValue=" old "
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Name' });
    await user.clear(input);
    await user.type(input, '  new name  {Enter}');
    expect(onSubmit).toHaveBeenCalledWith('new name');
    expect(onClose).toHaveBeenCalledOnce();
  });
});
