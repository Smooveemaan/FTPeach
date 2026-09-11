import type { MouseEvent, MutableRefObject } from 'react';
import { useEffect, useState } from 'react';
import type {
  PaneOrientation,
  SettingsState,
  SettingsUpdaters,
} from '../features/settings/index.ts';
import type { ResizableSection } from './layout/sectionResizeReducer.ts';
import { useSectionResize } from './layout/useSectionResize.ts';
import type { AppSettings } from '../platform/api/settings.ts';
import { persistSetting } from '../platform/persistSetting.ts';

const PANE_STACK_BREAKPOINT = 750;

/**
 * Takes the two settings groups it owns rather than a dozen values and their
 * setters: every toggle below flips one field of `layout` or `logging` and
 * persists the same field.
 */
interface WorkspaceLayoutOptions {
  layout: SettingsState['layout'];
  logging: SettingsState['logging'];
  update: Pick<SettingsUpdaters, 'layout' | 'logging'>;
}

export interface WorkspaceLayoutModel {
  toggleLocalPane: () => void;
  toggleRemotePane: () => void;
  toggleTransferQueue: () => void;
  toggleHiddenFiles: () => void;
  toggleLog: () => void;
  togglePaneOrientation: () => void;
  hydrateFromSettings: (s: AppSettings) => void;
  transferLogRef: MutableRefObject<HTMLDivElement | null>;
  transferLogSplitRatio: number;
  resizingTransferLog: boolean;
  startTransferLogResize: (event: MouseEvent) => void;
  resetTransferLogSplitRatio: () => void;
  hydrateTransferLogSplit: (settings: AppSettings) => void;
  panesRef: MutableRefObject<HTMLDivElement | null>;
  splitRatio: number;
  resizing: boolean;
  startResize: (e: MouseEvent) => void;
  resetSplitRatio: () => void;
  transferQueueHeight: number;
  logPanelHeight: number;
  transferManuallyResized: boolean;
  logManuallyResized: boolean;
  resizingSection: ResizableSection | null;
  startSectionResize: (section: ResizableSection) => (e: MouseEvent) => void;
  resetSectionHeight: (section: ResizableSection) => () => void;
  windowNarrow: boolean;
  effectivePaneOrientation: PaneOrientation;
}

export function useWorkspaceLayout({
  layout,
  logging,
  update,
}: WorkspaceLayoutOptions): WorkspaceLayoutModel {
  const { showTransferQueue, paneOrientation } = layout;
  const { logEnabled } = logging;
  const [windowNarrow, setWindowNarrow] = useState(false);
  const effectivePaneOrientation = windowNarrow ? 'vertical' : paneOrientation;

  useEffect(() => {
    const checkWidth = () => setWindowNarrow(window.innerWidth < PANE_STACK_BREAKPOINT);
    checkWidth();
    window.addEventListener('resize', checkWidth);
    return () => window.removeEventListener('resize', checkWidth);
  }, []);

  const sectionResize = useSectionResize({
    showTransferQueue,
    logEnabled,
    paneOrientation: effectivePaneOrientation,
    windowNarrow,
  });

  const toggleLocalPane = () => {
    update.layout((previous) => {
      // Keep at least one pane visible.
      if (previous.showLocalPane && !previous.showRemotePane) return {};
      const next = !previous.showLocalPane;
      persistSetting({ showLocalPane: next });
      return { showLocalPane: next };
    });
  };

  const toggleRemotePane = () => {
    update.layout((previous) => {
      if (previous.showRemotePane && !previous.showLocalPane) return {};
      const next = !previous.showRemotePane;
      persistSetting({ showRemotePane: next });
      return { showRemotePane: next };
    });
  };

  const toggleTransferQueue = () => {
    update.layout((previous) => {
      const next = !previous.showTransferQueue;
      persistSetting({ showTransferQueue: next });
      return { showTransferQueue: next };
    });
  };

  const toggleHiddenFiles = () => {
    update.layout((previous) => {
      const next = !previous.showHiddenFiles;
      persistSetting({ showHiddenFiles: next });
      return { showHiddenFiles: next };
    });
  };

  const toggleLog = () => {
    update.logging((previous) => {
      const next = !previous.logEnabled;
      persistSetting({ logEnabled: next });
      return { logEnabled: next };
    });
  };

  const togglePaneOrientation = () => {
    update.layout((previous) => {
      const next = previous.paneOrientation === 'vertical' ? 'horizontal' : 'vertical';
      persistSetting({ paneOrientation: next });
      return { paneOrientation: next };
    });
  };

  return {
    windowNarrow,
    effectivePaneOrientation,
    ...sectionResize,
    toggleLocalPane,
    toggleRemotePane,
    toggleTransferQueue,
    toggleHiddenFiles,
    toggleLog,
    togglePaneOrientation,
  };
}
