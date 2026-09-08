import { describe, expect, test } from 'vitest';
import { installTauriTestAdapter } from '../helpers/tauriTestAdapter.ts';

describe('Tauri test adapter', () => {
  test('records IPC contracts and provides deterministic responses', async () => {
    const adapter = installTauriTestAdapter({ settings_get: { theme: 'dark' } });
    await expect(adapter.invoke('settings_get')).resolves.toEqual({ theme: 'dark' });
    expect(adapter.calls).toEqual([{ command: 'settings_get', args: undefined }]);
    await expect(adapter.listen('transfer-progress', () => {})).resolves.toEqual(
      expect.any(Function),
    );
  });
});
