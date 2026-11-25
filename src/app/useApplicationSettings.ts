import { useCallback, useEffect, useRef } from 'react';
import type { ColumnWidths, SettingsState, SettingsUpdaters } from '../features/settings/index.ts';
import type { AppSettings } from '../platform/api/settings.ts';
import { persistSetting } from '../platform/persistSetting.ts';
import {
  clampFileListScale,
  clampTerminalFontSize,
  FILE_LIST_SCALE_DEFAULT,
  TERMINAL_FONT_SIZE_DEFAULT,
} from '../shared/contentZoom.ts';
import type { PaneId } from '../shared/paneContracts.ts';

interface ApplicationSettingsOptions {
  interface?: Pick<SettingsState['interface'], 'fileListScale' | 'terminalFontSize'> | undefined;
  layout: SettingsState['layout'];
  applySettings: (settings: AppSettings) => void;
  update: Pick<SettingsUpdaters, 'interface' | 'layout'>;
  hydrateLayout: (settings: AppSettings) => void;
}

export interface ApplicationSettingsResult {
  applySettings: (settings: AppSettings) => void;
  changeTheme: (theme: string) => void;
  setFileListScale: (next: number | ((current: number) => number)) => void;
  setTerminalFontSize: (next: number | ((current: number) => number)) => void;
  changeLocalColumns: (side: PaneId) => (columns: string[]) => void;
  changeRemoteColumns: (side: PaneId) => (columns: string[]) => void;
  changeLocalColumnWidths: (side: PaneId) => (widths: ColumnWidths) => void;
  changeRemoteColumnWidths: (side: PaneId) => (widths: ColumnWidths) => void;
  changeTransferColumnWidths: (widths: ColumnWidths) => void;
  changeTransferHiddenColumns: (columns: string[]) => void;
  changeTransferColumnOrder: (order: string[]) => void;
}

export function useApplicationSettings(
  options: ApplicationSettingsOptions,
): ApplicationSettingsResult {
  const { applySettings: applySettingsState, hydrateLayout, update } = options;
  const layoutRef = useRef(options.layout);
  layoutRef.current = options.layout;
  const zoomRef = useRef({
    fileListScale: options.interface?.fileListScale ?? FILE_LIST_SCALE_DEFAULT,
    terminalFontSize: options.interface?.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT,
  });
  zoomRef.current = {
    fileListScale: options.interface?.fileListScale ?? FILE_LIST_SCALE_DEFAULT,
    terminalFontSize: options.interface?.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT,
  };
  const zoomPersistTimersRef = useRef<{
    fileListScale?: ReturnType<typeof setTimeout>;
    terminalFontSize?: ReturnType<typeof setTimeout>;
  }>({});
  useEffect(
    () => () => {
      if (zoomPersistTimersRef.current.fileListScale) {
        clearTimeout(zoomPersistTimersRef.current.fileListScale);
      }
      if (zoomPersistTimersRef.current.terminalFontSize) {
        clearTimeout(zoomPersistTimersRef.current.terminalFontSize);
      }
    },
    [],
  );
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

  const scheduleZoomPersist = useCallback(
    (key: 'fileListScale' | 'terminalFontSize', value: number) => {
      const existing = zoomPersistTimersRef.current[key];
      if (existing) clearTimeout(existing);
      zoomPersistTimersRef.current[key] = setTimeout(() => {
        delete zoomPersistTimersRef.current[key];
        persistSetting({ [key]: value });
      }, 250);
    },
    [],
  );

  const setFileListScale = useCallback(
    (next: number | ((current: number) => number)) => {
      const current = zoomRef.current.fileListScale;
      const resolved = clampFileListScale(typeof next === 'function' ? next(current) : next);
      if (resolved === current) return;
      zoomRef.current = { ...zoomRef.current, fileListScale: resolved };
      update.interface({ fileListScale: resolved });
      scheduleZoomPersist('fileListScale', resolved);
    },
    [update, scheduleZoomPersist],
  );

  const setTerminalFontSize = useCallback(
    (next: number | ((current: number) => number)) => {
      const current = zoomRef.current.terminalFontSize;
      const resolved = clampTerminalFontSize(typeof next === 'function' ? next(current) : next);
      if (resolved === current) return;
      zoomRef.current = { ...zoomRef.current, terminalFontSize: resolved };
      update.interface({ terminalFontSize: resolved });
      scheduleZoomPersist('terminalFontSize', resolved);
    },
    [update, scheduleZoomPersist],
  );

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
    setFileListScale,
    setTerminalFontSize,
    changeLocalColumns: (side: PaneId) => changeColumns('localColumns', side),
    changeRemoteColumns: (side: PaneId) => changeColumns('remoteColumns', side),
    changeLocalColumnWidths: (side: PaneId) => changeColumnWidths('localColumnWidths', side),
    changeRemoteColumnWidths: (side: PaneId) => changeColumnWidths('remoteColumnWidths', side),
    changeTransferColumnWidths,
    changeTransferColumnOrder,
    changeTransferHiddenColumns: (columns) => {
      update.layout({ transferHiddenColumns: columns });
      persistSetting({ transferHiddenColumns: columns });
    },
  };
}
