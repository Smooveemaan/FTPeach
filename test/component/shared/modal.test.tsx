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

  test('focus goes back to the last used pane when the opener is gone', () => {
    const pane = document.createElement('div');
    pane.tabIndex = 0;
    pane.setAttribute('data-focus-home', '');
    const menuItem = document.createElement('button');
    document.body.append(pane, menuItem);
    menuItem.focus();
    const view = render(
      <Modal title="Settings" onClose={() => {}}>
        <button>Close</button>
      </Modal>,
    );
    menuItem.remove();
    view.unmount();
    expect(document.activeElement).toBe(pane);
  });

  test('a prompt that fails validation keeps the dialog and the input', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(
      <PromptDialog
        title="Permissions"
        label="Mode"
        defaultValue="644"
        validate={(value) => (value === '999' ? 'Bad mode' : null)}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Mode' });
    await user.clear(input);
    await user.type(input, '999{Enter}');
    expect(screen.getByRole('alert').textContent).toBe('Bad mode');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('999');
  });

  test('Tab belongs to the dialog on top, and skips hidden fields', async () => {
    const user = userEvent.setup();
    const tree = (showUpper: boolean) => (
      <>
        <Modal title="Lower" onClose={() => {}}>
          <button>Lower</button>
        </Modal>
        {showUpper && (
          <Modal title="Upper" onClose={() => {}}>
            <button>Upper</button>
            <input aria-label="Hidden" hidden />
            <div hidden>
              <button>Inside hidden</button>
            </div>
          </Modal>
        )}
      </>
    );
    const view = render(tree(true));
    const upper = screen.getByRole('button', { name: 'Upper' });
    expect(document.activeElement).toBe(upper);
    const reached = new Set<Element | null>();
    for (let index = 0; index < 6; index += 1) {
      await user.tab();
      reached.add(document.activeElement);
    }
    const upperDialog = screen.getByRole('dialog', { name: 'Upper' });
    for (const element of reached) expect(upperDialog.contains(element)).toBe(true);
    expect(reached.has(screen.getByText('Inside hidden'))).toBe(false);

    // Once the upper one closes, the lower one traps Tab again.
    view.rerender(tree(false));
    screen.getByRole('button', { name: 'Lower' }).focus();
    await user.tab();
    expect(screen.getByRole('dialog', { name: 'Lower' }).contains(document.activeElement)).toBe(
      true,
    );
  });

  test('the background is inert while a dialog is open, in whatever order dialogs close', () => {
    const background = document.createElement('button');
    const titleBar = document.createElement('div');
    titleBar.className = 'title-bar';
    const alreadyInert = document.createElement('div');
    alreadyInert.setAttribute('inert', '');
    document.body.append(titleBar, background, alreadyInert);
    const tree = (lower: boolean, upper: boolean) => (
      <>
        {lower && (
          <Modal title="Lower" onClose={() => {}}>
            <button>Lower</button>
          </Modal>
        )}
        {upper && (
          <Modal title="Upper" onClose={() => {}}>
            <button>Upper</button>
          </Modal>
        )}
      </>
    );
    const view = render(tree(true, true));
    expect(background.hasAttribute('inert')).toBe(true);
    expect(titleBar.hasAttribute('inert')).toBe(false);
    expect(screen.getByRole('dialog', { name: 'Lower' }).closest('[inert]')).not.toBeNull();
    expect(screen.getByRole('dialog', { name: 'Upper' }).closest('[inert]')).toBeNull();

    // The lower dialog closing first must not free what the upper one holds.
    view.rerender(tree(false, true));
    expect(background.hasAttribute('inert')).toBe(true);
    view.rerender(tree(false, false));
    expect(background.hasAttribute('inert')).toBe(false);
    expect(alreadyInert.hasAttribute('inert')).toBe(true);
  });

  test('a dialog with nothing to focus keeps focus on itself', async () => {
    const user = userEvent.setup();
    render(
      <Modal title="Busy" onClose={() => {}} closeDisabled>
        <p>Working</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Busy' });
    expect(document.activeElement).toBe(dialog);
    await user.tab();
    expect(document.activeElement).toBe(dialog);
  });
});
