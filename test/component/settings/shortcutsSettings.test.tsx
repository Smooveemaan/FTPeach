import React, { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import ShortcutsSettings from '../../../src/features/settings/components/ShortcutsSettings.tsx';
import type { ShortcutOverrides } from '../../../src/features/settings/useSettings.ts';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: object) =>
      options ? `${key}(${Object.values(options).join(',')})` : key,
  }),
}));

function Harness() {
  // Also cover a default binding explicitly saved by an older version.
  const [overrides, setOverrides] = useState<ShortcutOverrides>({ 'search-local': 'Ctrl+KeyF' });
  return (
    <ShortcutsSettings
      shortcutOverridesValue={overrides}
      setShortcutOverridesValue={setOverrides}
      paneOrientation="horizontal"
    />
  );
}

test('reset buttons reflect actual differences, including recording the default again', () => {
  render(<Harness />);
  const recorder = screen.getByRole('button', { name: 'Ctrl+F' });
  const row = recorder.closest('.settings-shortcut-row') as HTMLElement;
  const reset = within(row).getByRole('button', { name: 'settings.shortcuts.reset' });
  const resetAll = screen.getByRole('button', { name: 'settings.shortcuts.resetAll' });
  expect(reset).toHaveProperty('disabled', true);
  expect(resetAll).toHaveProperty('disabled', true);

  for (const [code, disabled] of [
    ['KeyF', true],
    ['KeyQ', false],
    ['KeyF', true],
  ] as const) {
    fireEvent.click(recorder);
    fireEvent.keyDown(recorder, { code, ctrlKey: true });
    expect(reset).toHaveProperty('disabled', disabled);
    expect(resetAll).toHaveProperty('disabled', disabled);
  }

  fireEvent.click(within(row).getByRole('button', { name: 'settings.shortcuts.unassign' }));
  expect(reset).toHaveProperty('disabled', false);
  expect(resetAll).toHaveProperty('disabled', false);
  fireEvent.click(reset);
  expect(reset).toHaveProperty('disabled', true);
  expect(resetAll).toHaveProperty('disabled', true);
});

test('a conflict icon names the other action with its pane side and goes to it', () => {
  render(
    <ShortcutsSettings
      shortcutOverridesValue={{ 'save-site': 'Ctrl+KeyF' }}
      setShortcutOverridesValue={() => {}}
      paneOrientation="horizontal"
    />,
  );
  const [conflict] = screen.getAllByRole('button', {
    name: 'settings.shortcuts.conflict(settings.shortcuts.actions.search(paneSide.left))',
  });
  fireEvent.click(conflict!);
  expect(
    document.activeElement?.closest('[data-shortcut-action]')?.getAttribute('data-shortcut-action'),
  ).toBe('search-local');
});

test('a key shared by three actions lists both others', () => {
  render(
    <ShortcutsSettings
      shortcutOverridesValue={{ 'save-site': 'Ctrl+KeyF', 'open-settings': 'Ctrl+KeyF' }}
      setShortcutOverridesValue={() => {}}
      paneOrientation="horizontal"
    />,
  );
  const labels = screen
    .getAllByRole('button', { name: /^settings.shortcuts.conflict/ })
    .map((button) => button.getAttribute('aria-label'));
  expect(labels.some((label) => label?.split('statusBar.listSeparator').length === 2)).toBe(true);
});
