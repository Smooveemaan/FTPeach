import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import LineStylePulse from '../components/LineStylePulse.tsx';
import { subscribeTransfers } from '../features/transfers/index.ts';
import type { PaneStatus } from '../shared/paneContracts.ts';
import type { connectionVisualState } from './useApplicationController.ts';

type PaneOrientation = 'horizontal' | 'vertical';
type ConnectionVisualState = ReturnType<typeof connectionVisualState>;

interface StatusBarProps {
  status: PaneStatus;
  paneOrientation: PaneOrientation;
  leftCount: number;
  rightCount: number;
  leftSelectedCount: number;
  rightSelectedCount: number;
  syncBrowsing: boolean;
  connectionVisualState: ConnectionVisualState;
  logLineCount: number;
  hasActiveTransfers: boolean;
  activeTransfersCount: number;
  hasPausedTransfers: boolean;
  update?: ReactNode;
  /** The window is in its narrow layout, where the pane counts give way to a transfer. */
  narrow?: boolean;
  /** Quitting waits for the transfers; offers to stop waiting. */
  quitPending?: { onCancel: () => void } | undefined;
}

export default function StatusBar({
  paneOrientation,
  leftCount,
  rightCount,
  leftSelectedCount,
  rightSelectedCount,
  syncBrowsing,
  connectionVisualState,
  logLineCount,
  hasActiveTransfers,
  activeTransfersCount,
  update,
  narrow = false,
  quitPending,
}: StatusBarProps) {
  const { t } = useTranslation();
  const [tick, setTick] = useState(0);
  useEffect(() => subscribeTransfers(() => setTick((t) => t + 1)), []);
  const skipFirstLogTick = useRef(true);
  useEffect(() => {
    if (skipFirstLogTick.current) {
      skipFirstLogTick.current = false;
      return;
    }
    setTick((t) => t + 1);
  }, [logLineCount]);

  const [firstCountKey, secondCountKey] =
    paneOrientation === 'vertical'
      ? ['statusBar.topCount', 'statusBar.bottomCount']
      : ['statusBar.leftCount', 'statusBar.rightCount'];
  return (
    <div className="status-bar">
      <span className="status-left">
        <LineStylePulse state={connectionVisualState} tick={tick} size={12} />
        <span className={`status-text state-${connectionVisualState}`}>
          {t(STATUS_TEXT_KEYS[connectionVisualState])}
        </span>
        <span className="status-transfers">
          {t('statusBar.transfers', { count: activeTransfersCount })}
        </span>
        {update}
        {quitPending && (
          <span className="status-quit">
            {t('statusBar.quitPending')}
            <button type="button" className="status-update-action" onClick={quitPending.onCancel}>
              {t('statusBar.cancelQuit')}
            </button>
          </span>
        )}
      </span>
      <span className="status-right">
        {syncBrowsing && <span className="sync-indicator">⇄ {t('menu.view.syncBrowsing')}</span>}
        {!(narrow && hasActiveTransfers) && (
          <>
            <span>
              {t(firstCountKey, { count: leftCount })}
              {leftSelectedCount > 0 && t('statusBar.selectedSuffix', { count: leftSelectedCount })}
            </span>
            <span>
              {t(secondCountKey, { count: rightCount })}
              {rightSelectedCount > 0 &&
                t('statusBar.selectedSuffix', { count: rightSelectedCount })}
            </span>
          </>
        )}
      </span>
    </div>
  );
}

const STATUS_TEXT_KEYS = {
  idle: 'statusBar.status.disconnected',
  error: 'statusBar.status.connectFailed',
  connecting: 'statusBar.status.connecting',
  paused: 'statusBar.status.paused',
  connected: 'statusBar.status.connected',
  transferring: 'statusBar.status.transferring',
} as const satisfies Record<ConnectionVisualState, string>;
