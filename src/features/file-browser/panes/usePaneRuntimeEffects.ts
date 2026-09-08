import type { Dispatch, SetStateAction } from 'react';
import { useEffect } from 'react';
import { api } from '../../../platform/api/index.ts';
import type { TabState } from './paneModel.ts';
import { isConnectionLoss } from './paneModel.ts';

type SetTabs = Dispatch<SetStateAction<TabState[]>>;

export function useTransferConnectionLoss(setTabs: SetTabs, connectionResetMessage: string): void {
  useEffect(
    () =>
      api.transfer.onProgress((payload) => {
        if (
          payload.status !== 'error' ||
          (payload.errorCode !== 'connectionLost' && !isConnectionLoss(payload.error))
        )
          return;
        setTabs((previous) =>
          previous.map((tab) => ({
            ...tab,
            panes: {
              a:
                tab.panes.a.connectionId === payload.connectionId && tab.panes.a.status !== 'idle'
                  ? {
                      ...tab.panes.a,
                      status: 'error' as const,
                      loading: false,
                      errorMessage: connectionResetMessage,
                    }
                  : tab.panes.a,
              b:
                tab.panes.b.connectionId === payload.connectionId && tab.panes.b.status !== 'idle'
                  ? {
                      ...tab.panes.b,
                      status: 'error' as const,
                      loading: false,
                      errorMessage: connectionResetMessage,
                    }
                  : tab.panes.b,
            },
          })),
        );
      }),
    [connectionResetMessage, setTabs],
  );
}

export function useClearPaneSelection(activeTabId: string, setTabs: SetTabs): void {
  useEffect(() => {
    const clearSelectionOutside = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest('.pane') ||
        target?.closest('.modal-overlay') ||
        target?.closest('.menu-bar')
      )
        return;
      setTabs((previous) =>
        previous.map((tab) =>
          tab.id !== activeTabId
            ? tab
            : {
                ...tab,
                panes: {
                  a: { ...tab.panes.a, selected: new Set() },
                  b: { ...tab.panes.b, selected: new Set() },
                },
              },
        ),
      );
    };
    document.addEventListener('mousedown', clearSelectionOutside);
    return () => document.removeEventListener('mousedown', clearSelectionOutside);
  }, [activeTabId, setTabs]);
}
