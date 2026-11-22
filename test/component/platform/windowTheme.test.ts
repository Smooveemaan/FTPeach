import { afterEach, expect, test, vi } from 'vitest';
import { tauriApi } from '../../../src/platform/tauriApi.ts';

const nativeWindow = vi.hoisted(() => ({
  setTheme: vi.fn().mockResolvedValue(undefined),
  setBackgroundColor: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => nativeWindow,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

test.each([
  ['Linux', 'system', false, 'dark'],
  ['Linux', 'system', true, 'light'],
  ['Linux', 'dark', false, 'dark'],
  ['Linux', 'light', true, 'light'],
  ['Windows', 'system', false, null],
  ['Macintosh', 'system', true, null],
  ['Windows', 'dark', false, 'dark'],
  ['Macintosh', 'light', true, 'light'],
] as const)('%s theme %s (light=%s) uses native theme %s', (agent, theme, light, expected) => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(agent);

  tauriApi.app.setWindowTheme(theme, {
    background: [20, 19, 18],
    border: [41, 38, 34],
    confirmation: { light, colorScheme: 'peach', background: [26, 25, 23] },
  });

  expect(nativeWindow.setTheme).toHaveBeenCalledExactlyOnceWith(expected);
  expect(nativeWindow.setBackgroundColor).toHaveBeenCalledExactlyOnceWith([
    20,
    19,
    18,
    agent === 'Linux' ? 0 : 255,
  ]);
});
