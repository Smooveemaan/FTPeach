import type { EventRegistrar, InvokeFn } from '../ipcContracts.ts';

export interface AppMenuItemPayload {
  id?: string | undefined;
  label?: string | undefined;
  separator?: boolean | undefined;
  disabled?: boolean | undefined;
  checked?: boolean | undefined;
  shortcut?: string | undefined;
  children?: AppMenuItemPayload[] | undefined;
}

export interface AppMenuTopEntry {
  id?: string | undefined;
  label: string;
  items: AppMenuItemPayload[];
}

export interface AppMenuModel {
  menus: AppMenuTopEntry[];
}

export function createAppMenuApi(invoke: InvokeFn, onEvent: EventRegistrar) {
  return {
    setModel: (model: AppMenuModel) => invoke('app_menu_set_model', { model }),
    onAction: onEvent('app-menu:action', (val): val is string => typeof val === 'string'),
  };
}
