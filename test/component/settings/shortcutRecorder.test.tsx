import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import ShortcutRecorder from '../../../src/components/ShortcutRecorder.tsx';
import { useAppCommands } from '../../../src/app/useAppCommands.ts';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const captureKeys = {
  onKeyDown: (callback: (_event: KeyboardEvent) => void) => {
    window.addEventListener('keydown', callback, { capture: true });
    return () => window.removeEventListener('keydown', callback, { capture: true });
  },
};

function Harness({ onSaveSite, onChange }: { onSaveSite: () => void; onChange: () => void }) {
  useAppCommands(
    { modalOpen: false, openDevtools: () => {}, 'save-site': onSaveSite },
    null,
    captureKeys,
  );
  return <ShortcutRecorder value="Ctrl+KeyD" onChange={onChange} />;
}

test('a key combination being recorded does not also run the app command bound to it', () => {
  const onSaveSite = vi.fn();
  const onChange = vi.fn();
  render(<Harness onSaveSite={onSaveSite} onChange={onChange} />);
  const recorder = screen.getByRole('button');
  fireEvent.click(recorder);
  fireEvent.keyDown(recorder, { code: 'KeyS', key: 's', ctrlKey: true });
  expect(onChange).toHaveBeenCalledWith('Ctrl+KeyS');
  expect(onSaveSite).not.toHaveBeenCalled();

  // Outside recording the same keys still reach the app.
  fireEvent.keyDown(recorder, { code: 'KeyS', key: 's', ctrlKey: true });
  expect(onSaveSite).toHaveBeenCalledOnce();
});
