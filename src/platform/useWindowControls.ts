import { useEffect, useRef, useState } from 'react';
import { handler, reportRejection } from '../shared/asyncFailure.ts';
import { api } from './api/index.ts';

/** Native operations required by the application title bar. */
export interface NativeWindowControls {
  isMaximized: () => Promise<boolean>;
  onResized: (callback: () => void) => Promise<() => void>;
  hideToTray: () => Promise<unknown>;
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
}

const loadWindow = async (): Promise<NativeWindowControls> => {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const nativeWindow = getCurrentWindow();
  return {
    isMaximized: () => nativeWindow.isMaximized(),
    onResized: (callback) => nativeWindow.onResized(callback),
    // The backend puts the icon in the tray before it hides the window.
    hideToTray: () => api.tray.hideWindow(),
    minimize: () => nativeWindow.minimize(),
    toggleMaximize: () => nativeWindow.toggleMaximize(),
    close: () => nativeWindow.close(),
  };
};

export interface WindowControlsModel {
  available: boolean;
  maximized: boolean;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
}

/** Owns native window commands and releases even subscriptions that resolve after unmount. */
export function useWindowControls(
  minimizeToTray: boolean,
  getWindow: () => Promise<NativeWindowControls> = loadWindow,
  available = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
): WindowControlsModel {
  const [maximized, setMaximized] = useState(false);
  const windowRef = useRef<NativeWindowControls | null>(null);

  useEffect(() => {
    if (!available) return;
    const session = { cancelled: false, request: 0 };
    const isCancelled = () => session.cancelled;
    let unlisten: (() => void) | undefined;
    reportRejection(
      (async () => {
        const nativeWindow = await getWindow();
        if (isCancelled()) return;
        windowRef.current = nativeWindow;
        const refresh = async () => {
          const request = ++session.request;
          const value = await nativeWindow.isMaximized();
          if (!isCancelled() && request === session.request) setMaximized(value);
        };
        const release = await nativeWindow.onResized(handler(refresh));
        if (isCancelled()) {
          release();
          return;
        }
        unlisten = release;
        await refresh();
      })(),
    );
    return () => {
      session.cancelled = true;
      windowRef.current = null;
      unlisten?.();
    };
  }, [available, getWindow]);

  return {
    available,
    maximized,
    minimize: handler(() =>
      minimizeToTray ? windowRef.current?.hideToTray() : windowRef.current?.minimize(),
    ),
    toggleMaximize: handler(() => windowRef.current?.toggleMaximize()),
    close: handler(() => windowRef.current?.close()),
  };
}
