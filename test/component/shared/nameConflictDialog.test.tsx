import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import NameConflictDialog from '../../../src/components/NameConflictDialog.tsx';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

test('name conflict offers three decisions and applies the checked one to the remainder', () => {
  const decide = vi.fn();
  render(
    <NameConflictDialog name="file.txt" remaining={2} onDecision={decide} onClose={vi.fn()} />,
  );
  expect(screen.getByRole('button', { name: 'confirm.overwriteLabel' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'confirm.skipLabel' })).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: 'confirm.applyToAllRemaining' }));
  fireEvent.click(screen.getByRole('button', { name: 'confirm.createCopyLabel' }));
  expect(decide).toHaveBeenCalledWith({ action: 'copy', applyToAll: true });
});

test('Escape skips only the current file and a single conflict has no apply-all checkbox', () => {
  const close = vi.fn();
  render(<NameConflictDialog name="file.txt" remaining={0} onDecision={vi.fn()} onClose={close} />);
  expect(screen.queryByRole('checkbox')).toBeNull();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(close).toHaveBeenCalledOnce();
});
