import { useCallback, useRef } from 'react';
import type { ColumnWidths, SettingsState, SettingsUpdaters } from '../features/settings/index.ts';
import type { AppSettings } from '../platform/api/settings.ts';
import { persistSetting } from '../platform/persistSetting.ts';
import type { PaneId } from '../shared/types.ts';

interface ApplicationSettingsOptions {
  layout: SettingsState['layout'];
  applySettings: (settings: AppSettings) => void;
  update: Pick<SettingsUpdaters, 'interface' | 'layout'>;
  hydrateLayout: (settings: AppSettings) => void;
}

export interface ApplicationSettingsResult {
  applySettings: (settings: AppSettings) => void;
  changeTheme: (theme: string) => void;
  changeLocalColumns: (side: PaneId) => (columns: string[]) => void;
  changeRemoteColumns: (side: PaneId) => (columns: string[]) => void;
  changeLocalColumnWidths: (side: PaneId) => (widths: ColumnWidths) => void;
  changeRemoteColumnWidths: (side: PaneId) => (widths: ColumnWidths) => void;
  changeTransferColumnWidths: (widths: ColumnWidths) => void;
  changeTransferColumnOrder: (order: string[]) => void;
}

export function useApplicationSettings(
  options: ApplicationSettingsOptions,
): ApplicationSettingsResult {
  const { applySettings: applySettingsState, hydrateLayout, update } = options;
  const layoutRef = useRef(options.layout);
  layoutRef.current = options.layout;
  const applySettings = useCallback(
    (settings: AppSettings) => {
      applySettingsState(settings);
      hydrateLayout(settings);
    },
    [applySettingsState, hydrateLayout],
  );

  const changeTheme = (theme: string) => {
    update.interface({ theme });
    persistSetting({ theme });
  };

  const changeColumns =
    (kind: 'localColumns' | 'remoteColumns', side: PaneId) => (columns: string[]) => {
      const next = { ...layoutRef.current[kind], [side]: columns };
      layoutRef.current = { ...layoutRef.current, [kind]: next };
      update.layout({ [kind]: next });
      persistSetting({ [kind]: next });
    };

  const changeColumnWidths =
    (kind: 'localColumnWidths' | 'remoteColumnWidths', side: PaneId) => (widths: ColumnWidths) => {
      const next = { ...layoutRef.current[kind], [side]: widths };
      layoutRef.current = { ...layoutRef.current, [kind]: next };
      update.layout({ [kind]: next });
      persistSetting({ [kind]: next });
    };

  const changeTransferColumnWidths = (widths: ColumnWidths) => {
    update.layout({ transferColumnWidths: widths });
    persistSetting({ transferColumnWidths: widths });
  };

  const changeTransferColumnOrder = (order: string[]) => {
    update.layout({ transferColumnOrder: order });
    persistSetting({ transferColumnOrder: order });
  };

  return {
    applySettings,
    changeTheme,
    changeLocalColumns: (side: PaneId) => changeColumns('localColumns', side),
    changeRemoteColumns: (side: PaneId) => changeColumns('remoteColumns', side),
    changeLocalColumnWidths: (side: PaneId) => changeColumnWidths('localColumnWidths', side),
    changeRemoteColumnWidths: (side: PaneId) => changeColumnWidths('remoteColumnWidths', side),
    changeTransferColumnWidths,
    changeTransferColumnOrder,
  };
}
