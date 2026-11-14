import { afterEach, expect, test, vi } from 'vitest';
import { clipboard } from '../../../src/platform/clipboard.ts';

const { invoke, isTauri } = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

test('Linux desktop clipboard bypasses WebKit permission checks and forwards errors', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Linux');
  isTauri.mockReturnValue(true);
  const writeText = vi.fn().mockRejectedValue(new Error('Browser clipboard denied'));
  vi.stubGlobal('navigator', { userAgent: 'Linux', clipboard: { writeText } });
  invoke.mockResolvedValueOnce(undefined);
  const text = '/home/user/folder with spaces/é.txt\n/other';
  await clipboard.writeText(text);
  expect(invoke).toHaveBeenCalledWith('app_write_clipboard_text', { text });
  expect(writeText).not.toHaveBeenCalled();
  const error = new Error('GTK unavailable');
  invoke.mockRejectedValueOnce(error);
  await expect(clipboard.writeText(text)).rejects.toBe(error);
});

test.each([
  ['Linux', false],
  ['Windows NT 10.0', true],
  ['Macintosh', true],
])('%s (Tauri: %s) retains the browser clipboard', async (userAgent, desktop) => {
  isTauri.mockReturnValue(desktop);
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { userAgent, clipboard: { writeText } });
  await clipboard.writeText('path');
  expect(writeText).toHaveBeenCalledWith('path');
  expect(invoke).not.toHaveBeenCalled();
});
