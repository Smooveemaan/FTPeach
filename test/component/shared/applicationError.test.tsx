import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import AppBanners from '../../../src/app/AppBanners.tsx';
import { useApplicationError } from '../../../src/app/useApplicationError.ts';

test('automatic withdrawal removes only the operation that recovered', () => {
  const { result } = renderHook(() => useApplicationError());
  const first = { message: 'Same failure' };
  const second = { message: 'Same failure' };
  act(() => {
    result.current.reportError(first);
    result.current.reportError(second);
    result.current.reportError('Same failure', 'pane:a');
    result.current.reportError('Same failure', 'pane:b');
  });
  assert.equal(result.current.errorMessages.length, 3);
  act(() => {
    result.current.withdrawError(first);
    result.current.withdrawError('Same failure', 'pane:a');
  });
  assert.deepEqual(
    result.current.errorMessages.map((item) => item.owner),
    ['pane:b', undefined],
  );
  assert.equal(result.current.errorMessages[0]?.raw, 'Same failure');
});

test('one owner updates in place and the list keeps the newest three', () => {
  const { result } = renderHook(() => useApplicationError());
  act(() => {
    result.current.reportError('One', 'a');
    result.current.reportError('Two', 'b');
    result.current.reportError('One updated', 'a');
    result.current.reportError('Three', 'c');
    result.current.reportError('Four', 'd');
  });
  assert.deepEqual(
    result.current.errorMessages.map((item) => item.text),
    ['Four', 'Three', 'One updated'],
  );
  act(() => result.current.dismissError(result.current.errorMessages[1]!.id));
  assert.deepEqual(
    result.current.errorMessages.map((item) => item.text),
    ['Four', 'One updated'],
  );
  act(() => result.current.reportError('', 'a'));
  assert.deepEqual(
    result.current.errorMessages.map((item) => item.text),
    ['Four'],
  );
});

test('banners close independently of secret notices', () => {
  const dismiss: number[] = [];
  render(
    <AppBanners
      errorMessages={[
        { id: 1, text: 'First', raw: 'First' },
        { id: 2, text: 'Second', raw: 'Second' },
      ]}
      onDismissError={(id) => dismiss.push(id)}
      legacyPasswordNotice
      onDismissLegacyPasswordNotice={() => undefined}
      plaintextSecretNotice={false}
      onDismissPlaintextSecretNotice={() => undefined}
      secretNotPersistedNotice={false}
      onDismissSecretNotPersistedNotice={() => undefined}
    />,
  );
  const closeButtons = screen.getAllByRole('button', { name: 'Close' });
  fireEvent.click(closeButtons[1]!);
  assert.deepEqual(dismiss, [2]);
  assert.ok(screen.getByText('First'));
  assert.ok(screen.getByText('Second'));
});
