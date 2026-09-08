import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { usePaneRefresh } from '../../../src/features/file-browser/panes/usePaneRefresh.ts';
import { makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';

test.each(['connecting', 'connected'] as const)(
  'reports listing failure globally only outside connection setup (%s)',
  async (status) => {
    const tab = makeTab('tab');
    tab.panes.b.kind = 'remote';
    tab.panes.b.connectionId = 'session';
    tab.panes.b.status = status;
    const failure = { ok: false, errorCode: 'invalidInput', error: 'Invalid URL', entries: [] };
    window.api = {
      session: { list: vi.fn().mockResolvedValue(failure) },
    } as unknown as Window['api'];
    const reportError = vi.fn();
    const { result } = renderHook(() =>
      usePaneRefresh({
        panes: tab.panes,
        activeTabId: tab.id,
        updatePane: vi.fn(),
        reportError,
        setErrorMessage: vi.fn(),
        defaultLocalPath: '',
      }),
    );
    await act(async () => {
      expect(await result.current.refreshPane('b', '/')).toEqual(failure);
    });
    expect(reportError).toHaveBeenCalledTimes(status === 'connecting' ? 0 : 1);
  },
);
