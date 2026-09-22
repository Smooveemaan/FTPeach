import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import {
  enqueueChange,
  useOpenWithLifecycle,
} from '../../../src/features/open-with/useOpenWithLifecycle.ts';
import { useRecoveredEdits } from '../../../src/features/open-with/useRecoveredEdits.ts';
import RecoveredEditsDialog from '../../../src/features/open-with/RecoveredEditsDialog.tsx';
import type { OpenWithChange, RecoveredEdit } from '../../../src/platform/ipcContracts.ts';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const connectedTab = {
  panes: {
    a: { kind: 'remote', status: 'connected', connectionId: 'session' },
    b: { kind: 'local', status: 'connected', connectionId: null },
  },
};

function openWithHarness() {
  let emit: (_change: OpenWithChange) => void = () => {};
  const openWithApi = {
    stop: vi.fn().mockResolvedValue({ ok: true }),
    markSynced: vi.fn().mockResolvedValue({ ok: true }),
    onChanged: (callback: (_change: OpenWithChange) => void) => {
      emit = callback;
      return () => {};
    },
    onProgress: () => () => {},
    start: vi.fn(),
  };
  const hook = renderHook(({ tabs }) => useOpenWithLifecycle(tabs, openWithApi), {
    initialProps: { tabs: [connectedTab] as never[] },
  });
  const open = (id: string) => {
    act(() =>
      hook.result.current.setTarget({
        path: `/${id}.txt`,
        connectionId: 'session',
        paneId: 'a',
        tabId: 'tab',
      }),
    );
    act(() =>
      hook.result.current.registerOpened({
        id,
        localPath: `C:\\tmp\\${id}.txt`,
        remotePath: `/${id}.txt`,
      }),
    );
  };
  return { hook, openWithApi, open, emit: (change: OpenWithChange) => act(() => emit(change)) };
}

test('a newer revision replaces the queued one in place', () => {
  const queue = enqueueChange(enqueueChange([], { id: 'a', revision: '1' }), {
    id: 'b',
    revision: '1',
  });
  expect(enqueueChange(queue, { id: 'a', revision: '2' })).toEqual([
    { id: 'a', revision: '2' },
    { id: 'b', revision: '1' },
  ]);
});

test('changes to several copies are all asked about, one at a time', () => {
  const h = openWithHarness();
  h.open('a');
  h.open('b');
  h.open('c');
  h.emit({ id: 'a', revision: '1' });
  h.emit({ id: 'b', revision: '1' });
  h.emit({ id: 'a', revision: '2' });
  h.emit({ id: 'c', revision: '1' });
  h.emit({ id: 'unknown', revision: '1' });

  const asked: OpenWithChange[] = [];
  while (h.hook.result.current.changed) {
    const change = h.hook.result.current.changed;
    asked.push(change);
    act(() => h.hook.result.current.dismissChanged(change));
  }
  expect(asked).toEqual([
    { id: 'a', revision: '2' },
    { id: 'b', revision: '1' },
    { id: 'c', revision: '1' },
  ]);
});

test('only an uploaded revision is marked synced, and a failed upload asks again', async () => {
  const h = openWithHarness();
  h.open('a');
  h.emit({ id: 'a', revision: '1' });
  const change = h.hook.result.current.changed!;
  act(() => h.hook.result.current.dismissChanged(change));
  expect(h.hook.result.current.changed).toBeNull();

  act(() => h.hook.result.current.retryChanged(change));
  expect(h.hook.result.current.changed).toEqual(change);
  expect(h.openWithApi.markSynced).not.toHaveBeenCalled();

  await act(async () => h.hook.result.current.confirmUploaded(change));
  expect(h.openWithApi.markSynced).toHaveBeenCalledWith('a', '1');
});

test('a closed connection drops its questions but a retry cannot revive them', () => {
  const h = openWithHarness();
  h.open('a');
  h.emit({ id: 'a', revision: '1' });
  const change = h.hook.result.current.changed!;
  h.hook.rerender({ tabs: [] });
  expect(h.hook.result.current.changed).toBeNull();
  act(() => h.hook.result.current.retryChanged(change));
  expect(h.hook.result.current.changed).toBeNull();
  expect(h.openWithApi.stop).toHaveBeenCalledWith('a');
});

test('an upload finishing or failing cannot consume or replace a newer queued edit', async () => {
  const h = openWithHarness();
  h.open('a');
  h.open('b');
  h.emit({ id: 'a', revision: '1' });
  const uploading = h.hook.result.current.changed!;
  act(() => h.hook.result.current.dismissChanged(uploading));
  h.emit({ id: 'b', revision: '1' });
  h.emit({ id: 'a', revision: '2' });
  await act(async () => h.hook.result.current.confirmUploaded(uploading));
  act(() => h.hook.result.current.retryChanged(uploading));
  const b = h.hook.result.current.changed!;
  expect(b.id).toBe('b');
  act(() => h.hook.result.current.dismissChanged(b));
  expect(h.hook.result.current.changed).toEqual({ id: 'a', revision: '2' });
  act(() => h.hook.result.current.dismissChanged(uploading));
  expect(h.hook.result.current.changed?.revision).toBe('2');
});

test('a refused sync acknowledgement keeps the change retryable', async () => {
  const h = openWithHarness();
  h.open('a');
  h.emit({ id: 'a', revision: '1' });
  const change = h.hook.result.current.changed!;
  act(() => h.hook.result.current.dismissChanged(change));
  h.openWithApi.markSynced.mockResolvedValueOnce({ ok: false, error: 'disk full' });
  await act(async () => h.hook.result.current.confirmUploaded(change));
  expect(h.hook.result.current.changed).toEqual(change);
});

const recovered: RecoveredEdit[] = [
  { name: 'index.html', remotePath: '/www/index.html', savedAt: '2026-09-22T10:00:00Z' },
  { name: 'legacy.txt', remotePath: null, savedAt: '2026-09-22T10:01:00Z' },
];

test('recovered edits are offered at start and stay unless deleted', async () => {
  const recoveryApi = {
    recoveredEdits: vi.fn().mockResolvedValue(recovered),
    revealRecoveredEdits: vi.fn().mockResolvedValue({ ok: true }),
    discardRecoveredEdits: vi.fn().mockResolvedValue({ ok: true }),
  };
  const { result } = renderHook(() => useRecoveredEdits(recoveryApi));
  await waitFor(() => expect(result.current.edits).toEqual(recovered));

  act(() => result.current.reveal());
  expect(recoveryApi.revealRecoveredEdits).toHaveBeenCalled();
  expect(result.current.edits).toHaveLength(2);

  act(() => result.current.later());
  expect(result.current.edits).toEqual([]);
  expect(recoveryApi.discardRecoveredEdits).not.toHaveBeenCalled();
});

test('a failed delete keeps the recovered edits listed', async () => {
  const recoveryApi = {
    recoveredEdits: vi.fn().mockResolvedValue(recovered),
    revealRecoveredEdits: vi.fn(),
    discardRecoveredEdits: vi.fn().mockResolvedValue({ ok: false, error: 'locked' }),
  };
  const { result } = renderHook(() => useRecoveredEdits(recoveryApi));
  await waitFor(() => expect(result.current.edits).toHaveLength(2));
  await act(async () => result.current.discard());
  expect(result.current.edits).toHaveLength(2);
});

test('deleting recovered edits takes a second, explicit step', () => {
  const onDiscard = vi.fn();
  render(
    <RecoveredEditsDialog
      edits={recovered}
      onReveal={vi.fn()}
      onDiscard={onDiscard}
      onLater={vi.fn()}
    />,
  );
  expect(screen.getByText('/www/index.html')).toBeTruthy();
  expect(screen.getByText('recoveredEdits.unknownPath')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'recoveredEdits.discard' }));
  expect(onDiscard).not.toHaveBeenCalled();
  expect(screen.getByText('recoveredEdits.confirmDiscard')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'recoveredEdits.discard' }));
  expect(onDiscard).toHaveBeenCalledTimes(1);
});
