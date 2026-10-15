import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import MenuItems from '../../../src/components/MenuItems.tsx';

test('a menu says which items are toggles and choices, and arrows move through every kind', () => {
  render(
    <MenuItems
      onAction={() => {}}
      items={[
        { label: 'Refresh', onClick: () => {} },
        { label: 'Show hidden files', checked: false, onClick: () => {} },
        { label: 'Dark Theme', checked: true, radio: true, onClick: () => {} },
      ]}
    />,
  );

  const plain = screen.getByRole('menuitem', { name: 'Refresh' });
  const toggle = screen.getByRole('menuitemcheckbox', { name: 'Show hidden files' });
  const choice = screen.getByRole('menuitemradio', { name: 'Dark Theme' });
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(choice.getAttribute('aria-checked')).toBe('true');
  // The check mark is drawn, not read out as part of the name.
  expect(choice.querySelector('.menu-item-check')?.getAttribute('aria-hidden')).toBe('true');

  expect(document.activeElement).toBe(plain);
  fireEvent.keyDown(plain, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(toggle);
  fireEvent.keyDown(toggle, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(choice);
  fireEvent.keyDown(choice, { key: 'Home' });
  expect(document.activeElement).toBe(plain);
  fireEvent.keyDown(plain, { key: 'End' });
  expect(document.activeElement).toBe(choice);
});

test('a shortcut shown on an item is also announced', () => {
  render(
    <MenuItems
      onAction={() => {}}
      items={[
        { label: 'New tab', shortcut: 'Ctrl+Shift+T', onClick: () => {} },
        { label: 'About', onClick: () => {} },
      ]}
    />,
  );
  expect(screen.getByRole('menuitem', { name: /New tab/ }).getAttribute('aria-keyshortcuts')).toBe(
    'Control+Shift+T',
  );
  expect(screen.getByRole('menuitem', { name: 'About' }).hasAttribute('aria-keyshortcuts')).toBe(
    false,
  );
});
