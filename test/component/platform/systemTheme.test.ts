import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { observeSystemTheme } from '../../../src/platform/systemTheme.ts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

let signal: (_event: { payload: unknown }) => void;
const release = vi.fn();
const media = {
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

beforeEach(() => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Linux');
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => media),
  );
  media.matches = false;
  vi.mocked(invoke).mockResolvedValue('dark');
  vi.mocked(listen).mockImplementation(async (_event, handler) => {
    signal = handler as typeof signal;
    return release;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test('Linux follows the portal over light GTK and keeps following desktop changes', async () => {
  const apply = vi.fn();
  const stop = observeSystemTheme(apply);
  await waitFor(() => expect(apply).toHaveBeenLastCalledWith('dark'));
  const onMediaChange = media.addEventListener.mock.calls[0]?.[1];
  onMediaChange();
  expect(apply).toHaveBeenLastCalledWith('dark');
  signal({ payload: 'light' });
  expect(apply).toHaveBeenLastCalledWith('light');
  signal({ payload: 'dark' });
  expect(apply).toHaveBeenLastCalledWith('dark');
  signal({ payload: 'invalid' });
  expect(apply).toHaveBeenLastCalledWith('dark');
  stop();
  signal({ payload: 'light' });
  expect(apply).toHaveBeenLastCalledWith('dark');
  expect(release).toHaveBeenCalledOnce();
  expect(media.removeEventListener).toHaveBeenCalledWith('change', onMediaChange);
});

test('a late initial read cannot overwrite a newer desktop change', async () => {
  let resolve!: (_value: string) => void;
  vi.mocked(invoke).mockReturnValue(
    new Promise<string>((done) => {
      resolve = done;
    }),
  );
  const apply = vi.fn();
  const stop = observeSystemTheme(apply);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('app_system_theme'));
  signal({ payload: 'dark' });
  resolve('light');
  await Promise.resolve();
  expect(apply).toHaveBeenLastCalledWith('dark');
  stop();
});

test('releases a subscription which finishes after disposal without reading or applying', async () => {
  let resolve!: (_value: () => void) => void;
  vi.mocked(listen).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const apply = vi.fn();
  const stop = observeSystemTheme(apply);
  apply.mockClear();
  stop();
  resolve(release);
  await waitFor(() => expect(release).toHaveBeenCalledOnce());
  expect(invoke).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
});

test('an unavailable portal retains media-query fallback', async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  const apply = vi.fn();
  const stop = observeSystemTheme(apply);
  await waitFor(() => expect(invoke).toHaveBeenCalled());
  media.matches = true;
  media.addEventListener.mock.calls[0]?.[1]();
  expect(apply).toHaveBeenLastCalledWith('dark');
  stop();
});

test('Windows keeps following media queries without Linux IPC', () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows');
  const apply = vi.fn();
  const stop = observeSystemTheme(apply);
  expect(apply).toHaveBeenLastCalledWith('light');
  media.matches = true;
  media.addEventListener.mock.calls[0]?.[1]();
  expect(apply).toHaveBeenLastCalledWith('dark');
  expect(listen).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  stop();
});
