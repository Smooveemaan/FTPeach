import type { MutableRefObject, MouseEvent as ReactMouseEvent } from 'react';
import { useRef, useState } from 'react';
import type { AppSettings } from '../../platform/api/settings.ts';
import { persistSetting } from '../../platform/persistSetting.ts';
import SETTINGS_DEFAULTS from '../../shared/settingsDefaults.ts';
import { useDragSession } from '../../hooks/resize/useDragSession.ts';

export interface TransferLogSplitModel {
  transferLogRef: MutableRefObject<HTMLDivElement | null>;
  transferLogSplitRatio: number;
  resizingTransferLog: boolean;
  startTransferLogResize: (event: ReactMouseEvent) => void;
  resetTransferLogSplitRatio: () => void;
  hydrateTransferLogSplit: (settings: AppSettings) => void;
}

export function useTransferLogSplit(): TransferLogSplitModel {
  const [transferLogSplitRatio, setTransferLogSplitRatio] = useState(
    SETTINGS_DEFAULTS.transferLogSplitRatio,
  );
  const transferLogRef = useRef<HTMLDivElement | null>(null);
  const [resizingTransferLog, setResizingTransferLog] = useState(false);
  const latestRatioRef = useRef(SETTINGS_DEFAULTS.transferLogSplitRatio);

  const startTransferLogResize = (event: ReactMouseEvent) => {
    event.preventDefault();
    setResizingTransferLog(true);
  };
  const resetTransferLogSplitRatio = () => {
    latestRatioRef.current = 0.5;
    setTransferLogSplitRatio(0.5);
    persistSetting({ transferLogSplitRatio: 0.5 });
  };

  useDragSession({
    active: resizingTransferLog,
    cursor: 'col-resize',
    createHandlers: () => ({
      onMove: ({ clientX, scale }) => {
        if (!transferLogRef.current) return;
        const domRect = transferLogRef.current.getBoundingClientRect();
        const rect = { left: domRect.left / scale, width: domRect.width / scale };
        const physicalRatio = (clientX - rect.left) / rect.width;
        const logicalRatio =
          getComputedStyle(transferLogRef.current).direction === 'rtl'
            ? 1 - physicalRatio
            : physicalRatio;
        const ratio = Math.min(0.8, Math.max(0.2, logicalRatio));
        latestRatioRef.current = ratio;
        setTransferLogSplitRatio(ratio);
      },
      onEnd: () => {
        setResizingTransferLog(false);
        persistSetting({ transferLogSplitRatio: latestRatioRef.current });
      },
    }),
    dependencies: [],
  });

  const hydrateTransferLogSplit = (settings: AppSettings) => {
    const ratio =
      typeof settings.transferLogSplitRatio === 'number'
        ? settings.transferLogSplitRatio
        : SETTINGS_DEFAULTS.transferLogSplitRatio;
    latestRatioRef.current = ratio;
    setTransferLogSplitRatio(ratio);
  };

  return {
    transferLogRef,
    transferLogSplitRatio,
    resizingTransferLog,
    startTransferLogResize,
    resetTransferLogSplitRatio,
    hydrateTransferLogSplit,
  };
}
