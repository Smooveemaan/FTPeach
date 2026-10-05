import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useProxyPasswordTest } from '../../../src/features/settings/hooks/useProxyPasswordTest.ts';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

test('a proxy test result fades for good once a field it was tested with changes', async () => {
  window.api = {
    vault: { onLocked: () => () => {} },
    proxy: { test: vi.fn().mockResolvedValue({ ok: false, error: 'refused' }) },
  } as unknown as Window['api'];
  const { result } = renderHook(() =>
    useProxyPasswordTest({
      proxyTypeValue: 'socks5',
      proxyHostValue: '127.0.0.1',
      proxyPortValue: '1080',
      proxyUsernameValue: 'user',
      markUnsavedChanges: () => {},
    }),
  );
  act(() => result.current.setProxyPasswordValue('wrong'));
  await act(() => result.current.testProxy());
  expect(result.current).toMatchObject({
    proxyTestResult: 'error',
    proxyTestMessage: 'refused',
    proxyTestRun: 1,
    proxyTestStale: false,
  });

  act(() => result.current.setProxyPasswordValue('wron'));
  expect(result.current.proxyTestStale).toBe(true);
  // Typing the same password again does not bring the old result back.
  act(() => result.current.setProxyPasswordValue('wrong'));
  expect(result.current.proxyTestStale).toBe(true);

  await act(() => result.current.testProxy());
  expect(result.current).toMatchObject({ proxyTestRun: 2, proxyTestStale: false });
});
