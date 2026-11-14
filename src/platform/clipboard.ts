import { invoke, isTauri } from '@tauri-apps/api/core';
import { hostPlatform } from './os.ts';

export const clipboard: Pick<Clipboard, 'writeText'> = {
  writeText(text) {
    if (hostPlatform() === 'linux' && isTauri())
      return invoke<void>('app_write_clipboard_text', { text });
    return navigator.clipboard.writeText(text);
  },
};
