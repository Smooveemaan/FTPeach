import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import AppBanners from '../../../src/app/AppBanners.tsx';
import { useApplicationError } from '../../../src/app/useApplicationError.ts';
import { createSettingsApi } from '../../../src/platform/api/settings.ts';
import { createSitesApi } from '../../../src/platform/api/sites.ts';
import type { InvokeFn, InvokeResult } from '../../../src/platform/ipcContracts.ts';

test('repeated settings and bookmarks reads show one storage warning without replacing other errors', async () => {
  const { result } = renderHook(() => useApplicationError());
  for (const code of ['unreadable', 'recovered', 'newer'] as const) {
    const warnings = [{ file: 'settings.json', code }];
    const invoke: InvokeFn = async <T,>(command: string) =>
      (command === 'settings_get'
        ? { storageWarnings: warnings }
        : { sites: [], warnings }) as InvokeResult<T>;
    const settings = createSettingsApi(invoke);
    const sites = createSitesApi(invoke);
    act(() => result.current.reportError('An independent failure', 'pane:a'));
    await act(async () => {
      await settings.get();
      await sites.list();
    });
    const first = result.current.errorMessages.find((message) =>
      message.text.includes('settings.json'),
    )!;
    assert.ok(first);
    await act(async () => {
      await settings.get();
      await sites.list();
    });
    assert.equal(result.current.errorMessages.length, 2);
    assert.equal(result.current.errorMessages[0]?.id, first.id);
    assert.equal(result.current.errorMessages[0]?.text, first.text);
    assert.equal(result.current.errorMessages[1]?.text, 'An independent failure');
    act(() => result.current.dismissError());
  }
});

test('automatic withdrawal distinguishes error objects with the same text', () => {
  const { result } = renderHook(() => useApplicationError());
  const first = { message: 'Same failure' };
  const second = { message: 'Same failure' };
  act(() => {
    result.current.reportError(first);
    result.current.reportError(second);
  });
  assert.equal(result.current.errorMessages.length, 2);
  act(() => result.current.withdrawError(first));
  assert.equal(result.current.errorMessages.length, 1);
  assert.equal(result.current.errorMessages[0]?.raw, second);
  act(() => result.current.withdrawError(second));
  assert.deepEqual(result.current.errorMessages, []);
});

test('automatic withdrawal removes only the operation that recovered', () => {
  const { result } = renderHook(() => useApplicationError());
  for (const second of ['Same failure', 'Different failure']) {
    act(() => {
      result.current.reportError('Same failure', 'pane:a');
      result.current.reportError(second, 'pane:b');
    });
    assert.equal(result.current.errorMessages.length, 2);
    act(() => result.current.withdrawError('Same failure', 'pane:a'));
    assert.equal(result.current.errorMessages.length, 1);
    assert.equal(result.current.errorMessages[0]?.owner, 'pane:b');
    assert.equal(result.current.errorMessages[0]?.raw, second);
    act(() => result.current.withdrawError(second, 'pane:b'));
    assert.deepEqual(result.current.errorMessages, []);
  }
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
