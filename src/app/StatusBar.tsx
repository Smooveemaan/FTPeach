import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import LineStylePulse from '../components/LineStylePulse.tsx';
import { subscribeTransfers } from '../features/transfers/index.ts';
import type { PaneStatus, Translate } from '../shared/types.ts';

type PaneOrientation = 'horizontal' | 'vertical';
type ConnectionVisualState = 'idle' | 'connecting' | 'paused' | 'connected';

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
}

interface StatusDescription {
  text: string;
  state: ConnectionVisualState;
}

export default function StatusBar({
  status,
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
  hasPausedTransfers,
  update,
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

  const { text, state } = describeStatus(status, hasActiveTransfers, hasPausedTransfers, t);
  const [firstCountKey, secondCountKey] =
    paneOrientation === 'vertical'
      ? ['statusBar.topCount', 'statusBar.bottomCount']
      : ['statusBar.leftCount', 'statusBar.rightCount'];
  return (
    <div className="status-bar">
      <span className="status-left">
        <LineStylePulse state={connectionVisualState} tick={tick} size={12} />
        <span className={`status-text state-${state}`}>{text}</span>
        <span className="status-transfers">
          {t('statusBar.transfers', { count: activeTransfersCount })}
        </span>
        {update}
      </span>
      <span className="status-right">
        {syncBrowsing && <span className="sync-indicator">⇄ {t('menu.view.syncBrowsing')}</span>}
        <span>
          {t(firstCountKey, { count: leftCount })}
          {leftSelectedCount > 0 && t('statusBar.selectedSuffix', { count: leftSelectedCount })}
        </span>
        <span>
          {t(secondCountKey, { count: rightCount })}
          {rightSelectedCount > 0 && t('statusBar.selectedSuffix', { count: rightSelectedCount })}
        </span>
      </span>
    </div>
  );
}

function describeStatus(
  status: PaneStatus,
  hasActiveTransfers: boolean,
  hasPausedTransfers: boolean,
  t: Translate,
): StatusDescription {
  if (status === 'connected') {
    if (hasActiveTransfers) return { text: t('statusBar.status.transferring'), state: 'connected' };
    if (hasPausedTransfers) return { text: t('statusBar.status.paused'), state: 'paused' };
    return { text: t('statusBar.status.connected'), state: 'connected' };
  }
  if (status === 'connecting')
    return { text: t('statusBar.status.connecting'), state: 'connecting' };
  if (status === 'error') return { text: t('statusBar.status.connectFailed'), state: 'idle' };
  return { text: t('statusBar.status.disconnected'), state: 'idle' };
}
