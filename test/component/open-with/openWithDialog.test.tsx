import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import OpenWithDialog from '../../../src/features/open-with/OpenWithDialog.tsx';
import type { PreviewProgress, CommandResult } from '../../../src/platform/ipcContracts.ts';
import { setAsyncFailureSink } from '../../../src/shared/asyncFailure.ts';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

function open() {
  let emit!: (_progress: PreviewProgress) => void;
  let finish!: (_result: CommandResult & { localPath?: string }) => void;
  let reject!: (_error: Error) => void;
  const pending = new Promise<CommandResult & { localPath?: string }>((resolve, fail) => {
    finish = resolve;
    reject = fail;
  });
  const unsubscribe = vi.fn();
  const start = vi.fn(
    (_connectionId: string, _path: string, _id: string, _application: string | null) => pending,
  );
  const stop = vi.fn().mockResolvedValue({ ok: true });
  const cancel = vi.fn().mockResolvedValue({ ok: true });
  window.api = {
    openWith: {
      start,
      stop,
      onProgress: (callback: typeof emit) => {
        emit = callback;
        return unsubscribe;
      },
    },
    transfer: { cancel },
  } as unknown as Window['api'];
  const props = {
    remotePath: '/folder/file.txt',
    connectionId: 'original-session',
    size: 100,
    application: 'editor',
    onOpened: vi.fn(),
    onClose: vi.fn(),
  };
  const view = render(<OpenWithDialog {...props} />);
  const id = start.mock.calls[0]![2];
  return {
    ...view,
    props,
    id,
    start,
    stop,
    cancel,
    unsubscribe,
    finish,
    reject,
    emit: (progress: PreviewProgress) => act(() => emit(progress)),
  };
}

test('download ignores other jobs, clamps progress and registers a completed editable copy', async () => {
  const h = open();
  h.emit({ id: 'other', connectionId: 'original-session', bytes: 100, total: 100 });
  expect(screen.getByText('openWithDialog.connecting')).toBeTruthy();
  h.emit({ id: h.id, connectionId: 'original-session', bytes: 40, total: 100 });
  expect(h.container.querySelector<HTMLElement>('.openwith-progress-fill')!.style.width).toBe(
    '40%',
  );
  h.emit({ id: h.id, connectionId: 'original-session', bytes: 150, total: 100 });
  expect(h.container.querySelector<HTMLElement>('.openwith-progress-fill')!.style.width).toBe(
    '100%',
  );
  await act(async () => h.finish({ ok: true, localPath: 'C:\\temp\\file.txt' }));
  expect(h.props.onOpened).toHaveBeenCalledExactlyOnceWith({
    id: h.id,
    localPath: 'C:\\temp\\file.txt',
    remotePath: '/folder/file.txt',
  });
  h.unmount();
  expect(h.unsubscribe).toHaveBeenCalledOnce();
  expect(h.cancel).not.toHaveBeenCalled();
  expect(h.stop).not.toHaveBeenCalled();
});

test('dismissal cancels the original session and cleans up a late successful watcher', async () => {
  const h = open();
  h.rerender(<OpenWithDialog {...h.props} connectionId="replacement-session" />);
  expect(h.start).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
  expect(h.props.onClose).toHaveBeenCalledOnce();
  h.unmount();
  expect(h.cancel).toHaveBeenCalledExactlyOnceWith('original-session', h.id, 'stop');
  await act(async () => h.finish({ ok: true, localPath: 'C:\\temp\\late.txt' }));
  expect(h.stop).toHaveBeenCalledWith(h.id);
  expect(h.props.onOpened).not.toHaveBeenCalled();
});

test('backend cancellation closes quietly without registering an edit', async () => {
  const h = open();
  await act(async () => h.finish({ ok: false, errorCode: 'cancelled' }));
  expect(h.props.onClose).toHaveBeenCalledOnce();
  expect(h.props.onOpened).not.toHaveBeenCalled();
});

test.each([
  [{ ok: false, error: 'download failed' }, 'download failed'],
  [{ ok: true }, 'errors.internal'],
])(
  'failed or malformed success never registers an editable copy: %j',
  async (response, message) => {
    const h = open();
    await act(async () => h.finish(response));
    expect(screen.getByText(message)).toBeTruthy();
    expect(h.props.onOpened).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'common.close' }).at(-1)!);
    expect(h.props.onClose).toHaveBeenCalledOnce();
  },
);

test('rejected IPC reaches the shared error sink and unmount cancels unfinished work', async () => {
  const sink = vi.fn();
  const dispose = setAsyncFailureSink(sink);
  try {
    const h = open();
    const failure = new Error('IPC unavailable');
    await act(async () => h.reject(failure));
    await waitFor(() => expect(sink).toHaveBeenCalledWith(failure));
    h.unmount();
    expect(h.cancel).toHaveBeenCalledWith('original-session', h.id, 'stop');
  } finally {
    dispose();
  }
});
