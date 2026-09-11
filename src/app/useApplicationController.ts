import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { TabState } from '../features/file-browser/index.ts';
import { api } from '../platform/api/index.ts';
import { describeUnknown } from '../platform/ipcContracts.ts';
import { setAsyncFailureSink } from '../shared/asyncFailure.ts';
import { friendlyError } from '../shared/errorMessages.ts';
import type { PaneId, PaneKind, PaneStatus } from '../shared/types.ts';
import type { ShortcutOverrides } from '../shortcuts/resolve.ts';
import { useAppCommands } from './useAppCommands.ts';

export interface ApplicationErrorModel {
  errorMessage: string;
  setErrorMessage: Dispatch<SetStateAction<string>>;
  reportError: (raw: unknown) => void;
  dismissError: () => void;
}

export function useApplicationError(): ApplicationErrorModel {
  const [errorMessage, setErrorMessage] = useState('');
  const reportError = useCallback((raw: unknown) => {
    const supported =
      typeof raw === 'string' || raw == null
        ? raw
        : typeof raw === 'object'
          ? (raw as { code?: string; message?: string })
          : describeUnknown(raw);
    setErrorMessage(friendlyError(supported) ?? '');
  }, []);
  const dismissError = useCallback(() => setErrorMessage(''), []);

  // Gives the async helpers in shared/asyncFailure.ts somewhere to write, so a
  // rejected IPC call deep in a hook still surfaces in this banner.
  useEffect(() => setAsyncFailureSink(reportError), [reportError]);

  return { errorMessage, setErrorMessage, reportError, dismissError };
}

export function useVaultUnlockRecovery(
  setRetries: Dispatch<SetStateAction<Array<() => unknown>>>,
): (retry: () => unknown) => Promise<void> {
  return useCallback(
    async (retry: () => unknown) => {
      try {
        const status = await api.vault.status();
        if (status.systemUnlockAvailable && status.systemUnlockEnabled) {
          const result = await api.vault.unlockSystem();
          if (result.ok) {
            retry();
            return;
          }
        }
      } catch {
        // Platform credentials are an optional fast path. The queued retry
        // still allows recovery through the independent master password.
      }
      setRetries((previous) => [...previous, retry]);
    },
    [setRetries],
  );
}

export interface ApplicationCommandBindings {
  modalOpen: boolean;
  keyboardShortcuts?: ShortcutOverrides | null;
  searchLocal: () => unknown;
  searchRemote: () => unknown;
  toggleHiddenFiles: () => unknown;
  freeConnectTargetPaneId: PaneId | null;
  startPaneConnect: (paneId: PaneId) => unknown;
  refreshBothPanes: () => unknown;
  panes: Record<PaneId, { kind: PaneKind; status: PaneStatus }>;
  handleSaveSite: (paneId: PaneId) => () => unknown;
  setShowSettings: (value: boolean) => unknown;
  openNewTab: () => unknown;
  tabs: readonly TabState[];
  closeTab: (tabId: string) => unknown;
  reopenClosedTab: () => unknown;
  activeTabId: string;
  setActiveTabId: (tabId: string) => unknown;
}

export function useApplicationCommandBindings(options: ApplicationCommandBindings): void {
  const {
    modalOpen,
    keyboardShortcuts,
    searchLocal,
    searchRemote,
    toggleHiddenFiles,
    freeConnectTargetPaneId,
    startPaneConnect,
    refreshBothPanes,
    panes,
    handleSaveSite,
    setShowSettings,
    openNewTab,
    tabs,
    closeTab,
    reopenClosedTab,
    activeTabId,
    setActiveTabId,
  } = options;

  useAppCommands(
    {
      modalOpen,
      openDevtools: () => api.app.openDevtools(),
      'search-local': searchLocal,
      'search-remote': searchRemote,
      'toggle-hidden-files': toggleHiddenFiles,
      'new-connection': () => freeConnectTargetPaneId && startPaneConnect(freeConnectTargetPaneId),
      refresh: refreshBothPanes,
      'save-site': () => {
        const pane = panes.a;
        if (pane.kind === 'local' || pane.status === 'connected') handleSaveSite('a')();
      },
      'save-site-secondary': () => {
        const pane = panes.b;
        if (pane.kind === 'local' || pane.status === 'connected') handleSaveSite('b')();
      },
      'open-settings': () => setShowSettings(true),
      'new-tab': openNewTab,
      'close-tab': () => tabs.length > 1 && closeTab(activeTabId),
      'reopen-closed-tab': reopenClosedTab,
      'next-tab': () => {
        if (tabs.length < 2) return;
        const index = tabs.findIndex((tab) => tab.id === activeTabId);
        const next = tabs[(index + 1) % tabs.length];
        if (next) setActiveTabId(next.id);
      },
      'prev-tab': () => {
        if (tabs.length < 2) return;
        const index = tabs.findIndex((tab) => tab.id === activeTabId);
        const previous = tabs[(index - 1 + tabs.length) % tabs.length];
        if (previous) setActiveTabId(previous.id);
      },
    },
    keyboardShortcuts,
  );
}

export function connectionVisualState(status: PaneStatus, hasPausedTransfers: boolean) {
  if (status === 'connected') return hasPausedTransfers ? 'paused' : 'connected';
  return status === 'connecting' ? 'connecting' : 'idle';
}

export function associatedApplication(path: string, associations: Record<string, string>) {
  const name = path.split('/').pop() || '';
  const extension = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
  return associations[extension] || null;
}
