import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import LineStylePulse from '../components/LineStylePulse.tsx';
import NoticeText from '../components/NoticeText.tsx';
import { useFitLevel } from '../hooks/useFitLevel.ts';
import { subscribeTransfers } from '../features/transfers/index.ts';
import type { PaneStatus } from '../shared/paneContracts.ts';
import type { connectionVisualState } from './useApplicationController.ts';
import { useNoticeSwap, type StatusNotice } from '../hooks/useStatusNotice.ts';

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
  /** A short-lived result message, such as what an import brought in. */
  notice?: StatusNotice | undefined;
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
  notice,
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
  // The message stands in for the connection status, the transfer count, the
  // update status, the sync indicator and the pane counts.
  const { showingNotice, phaseClass, onReplacedAnimationEnd } = useNoticeSwap(notice);
  // What does not fit is shortened in this order (FIT), in a wide window as in
  // a narrow one; only then does the status text or a count get cut off.
  const [barRef, fitLevel] = useFitLevel<HTMLDivElement>(
    FIT.quitButton,
    [
      connectionVisualState,
      activeTransfersCount,
      showingNotice,
      notice?.id,
      !!quitPending,
      syncBrowsing,
      leftCount,
      rightCount,
      leftSelectedCount,
      rightSelectedCount,
      narrow,
      hasActiveTransfers,
      paneOrientation,
    ].join('|'),
  );
  const syncLabel = t('menu.view.syncBrowsing');
  const quitLabel = t('statusBar.quitPending');
  return (
    <div ref={barRef} className={`status-bar${phaseClass}`}>
      <span className="status-left fit-shrink">
        {!showingNotice && (
          <>
            <LineStylePulse state={connectionVisualState} tick={tick} size={12} />
            <span
              className={`status-text state-${connectionVisualState} notice-replaced fit-shrink`}
              onAnimationEnd={onReplacedAnimationEnd}
            >
              {t(STATUS_TEXT_KEYS[connectionVisualState])}
            </span>
            <span className="status-transfers notice-replaced">
              {t('statusBar.transfers', { count: activeTransfersCount })}
            </span>
            {update}
          </>
        )}
        {/* The live region stays mounted so each message is announced; the
            text inside remounts per message to restart its fades. */}
        <span className="status-notice fit-shrink" role="status">
          {showingNotice && notice && (
            <NoticeText key={notice.id} notice={notice} short={fitLevel >= FIT.noticeShort} />
          )}
        </span>
        {quitPending && (
          <span className="status-quit">
            {fitLevel >= FIT.quitButton ? (
              <button
                type="button"
                className="status-update-action"
                data-tooltip={quitLabel}
                onClick={quitPending.onCancel}
              >
                {t('statusBar.cancelQuitLong')}
              </button>
            ) : (
              <>
                {fitLevel >= FIT.quitShort ? (
                  <span data-tooltip={quitLabel}>
                    <span className="visually-hidden">{quitLabel}</span>
                    <span aria-hidden="true">{t('statusBar.quitPendingShort')}</span>
                  </span>
                ) : (
                  quitLabel
                )}
                <button
                  type="button"
                  className="status-update-action"
                  onClick={quitPending.onCancel}
                >
                  {t('statusBar.cancelQuit')}
                </button>
              </>
            )}
          </span>
        )}
      </span>
      <span className="status-right">
        {syncBrowsing && !showingNotice && (
          <span
            className="sync-indicator notice-replaced fit-shrink"
            {...(fitLevel >= FIT.syncIcon
              ? { role: 'img', 'aria-label': syncLabel, 'data-tooltip': syncLabel }
              : {})}
          >
            {fitLevel >= FIT.syncIcon ? '⇄' : `⇄ ${syncLabel}`}
          </span>
        )}
        {!(narrow && hasActiveTransfers) && !showingNotice && (
          <>
            <span className="status-count notice-replaced fit-shrink">
              {t(firstCountKey, { count: leftCount })}
              {leftSelectedCount > 0 && t('statusBar.selectedSuffix', { count: leftSelectedCount })}
            </span>
            <span className="status-count notice-replaced fit-shrink">
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

/** The steps a tight status bar takes, each on top of the ones before. */
const FIT = { noticeShort: 1, syncIcon: 2, quitShort: 3, quitButton: 4 } as const;

const STATUS_TEXT_KEYS = {
  idle: 'statusBar.status.disconnected',
  error: 'statusBar.status.connectFailed',
  connecting: 'statusBar.status.connecting',
  paused: 'statusBar.status.paused',
  connected: 'statusBar.status.connected',
  transferring: 'statusBar.status.transferring',
} as const satisfies Record<ConnectionVisualState, string>;
