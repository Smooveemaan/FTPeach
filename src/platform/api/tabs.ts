import { checkedResponse, isCommandRecord, voidOutcome } from '../ipcContracts.ts';
import type { CommandResult, InvokeFn } from '../ipcContracts.ts';

export interface PersistedPane {
  kind?: 'local' | 'remote';
  path?: string;
  siteId?: string;
}
export interface PersistedTab {
  id?: string;
  name?: string;
  syncBrowsing?: boolean;
  panes?: Partial<Record<'a' | 'b', PersistedPane>>;
}
export interface PersistedTabsState {
  /** Null when the tab it named no longer exists (the store normalises it). */
  activeTabId?: string | null;
  tabs?: PersistedTab[];
}

function isPersistedPane(value: unknown): value is PersistedPane {
  return (
    isCommandRecord(value) &&
    (value.kind === undefined || value.kind === 'local' || value.kind === 'remote') &&
    (value.path === undefined || typeof value.path === 'string') &&
    (value.siteId === undefined || typeof value.siteId === 'string')
  );
}

function isPersistedTab(value: unknown): value is PersistedTab {
  return (
    isCommandRecord(value) &&
    (value.id === undefined || typeof value.id === 'string') &&
    (value.name === undefined || typeof value.name === 'string') &&
    (value.syncBrowsing === undefined || typeof value.syncBrowsing === 'boolean') &&
    (value.panes === undefined ||
      (isCommandRecord(value.panes) &&
        (value.panes.a === undefined || isPersistedPane(value.panes.a)) &&
        (value.panes.b === undefined || isPersistedPane(value.panes.b))))
  );
}

function isPersistedTabsState(value: unknown): value is PersistedTabsState {
  return (
    isCommandRecord(value) &&
    (value.activeTabId == null || typeof value.activeTabId === 'string') &&
    (value.tabs === undefined || (Array.isArray(value.tabs) && value.tabs.every(isPersistedTab)))
  );
}

export function createTabsApi(invoke: InvokeFn) {
  return {
    // `tabs_get` is declared on the Rust side as an untyped `Value`: whatever
    // was last written to the store comes back, including a state written by an
    // older build. Checking it here is the only thing standing between that and
    // the pane restore code.
    get: (): Promise<PersistedTabsState> =>
      checkedResponse('tabs_get', invoke('tabs_get'), isPersistedTabsState, () => ({})),
    // Both writes answer with nothing when they worked, so the caller has no
    // way to tell a stored session from a lost one unless the outcome is named.
    set: (state: PersistedTabsState): Promise<CommandResult> =>
      voidOutcome(invoke, 'tabs_set', { state }),
    clear: (): Promise<CommandResult> => voidOutcome(invoke, 'tabs_clear'),
  };
}
