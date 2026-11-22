import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { hostPlatform } from './os.ts';
import { reportAsyncFailure } from '../shared/asyncFailure.ts';

type Theme = 'dark' | 'light';

/** Observe the desktop preference independently of this application's GTK theme. */
export function observeSystemTheme(apply: (theme: Theme) => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let portalAvailable = false;
  const session = { disposed: false };
  const isDisposed = () => session.disposed;
  let revision = 0;
  let unlisten: (() => void) | undefined;
  const fallback = () => {
    if (!portalAvailable && !isDisposed()) apply(media.matches ? 'dark' : 'light');
  };
  fallback();
  media.addEventListener('change', fallback);
  if (hostPlatform() === 'linux' && '__TAURI_INTERNALS__' in window) {
    void (async () => {
      const release = await listen<unknown>('app:system-theme', ({ payload }) => {
        if (isDisposed() || (payload !== 'dark' && payload !== 'light')) return;
        revision += 1;
        portalAvailable = true;
        apply(payload);
      });
      if (isDisposed()) {
        release();
        return;
      }
      unlisten = release;
      const beforeRead = revision;
      const theme = await invoke<unknown>('app_system_theme');
      if (!isDisposed() && revision === beforeRead && (theme === 'dark' || theme === 'light')) {
        portalAvailable = true;
        apply(theme);
      }
    })().catch(reportAsyncFailure);
  }
  return () => {
    session.disposed = true;
    media.removeEventListener('change', fallback);
    unlisten?.();
  };
}
