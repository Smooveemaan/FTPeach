import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import ErrorBoundary from '../components/ErrorBoundary.tsx';
import { TransferQueue } from '../features/transfers/ui.ts';
import { LogPanel } from '../features/logs/index.ts';
import {
  TRANSFER_HEADER_HEIGHT_NARROW,
  LOG_HEADER_HEIGHT_NARROW,
} from '../shared/layoutMetrics.ts';
import type { SectionResizeModel as SectionResize } from './layout/useSectionResize.ts';

type TransferQueueProps = ComponentProps<typeof TransferQueue>;
type LogPanelProps = ComponentProps<typeof LogPanel>;

interface TransferLogSectionProps {
  windowNarrow: boolean;
  showTransferQueue: boolean;
  logEnabled: boolean;
  resizingSection: SectionResize['resizingSection'];
  startSectionResize: SectionResize['startSectionResize'];
  resetSectionHeight: SectionResize['resetSectionHeight'];
  transferLogRef: SectionResize['transferLogRef'];
  transferQueueHeight: number;
  logPanelHeight: number;
  transferManuallyResized: boolean;
  logManuallyResized: boolean;
  transferLogSplitRatio: number;
  resizingTransferLog: boolean;
  startTransferLogResize: SectionResize['startTransferLogResize'];
  resetTransferLogSplitRatio: SectionResize['resetTransferLogSplitRatio'];
  transfersEmpty: boolean;
  logEmpty: boolean;
  transfer: {
    onRetry: (id: string) => unknown;
    onPause: TransferQueueProps['onPause'];
    onStop: TransferQueueProps['onStop'];
    onClearCompleted: TransferQueueProps['onClearCompleted'];
    connectionLabels: TransferQueueProps['connectionLabels'];
    columnWidths: TransferQueueProps['columnWidths'];
    onColumnWidthsChange: TransferQueueProps['onColumnWidthsChange'];
    columnOrder: TransferQueueProps['columnOrder'];
    onColumnOrderChange: TransferQueueProps['onColumnOrderChange'];
  };
  log: {
    lines: LogPanelProps['lines'];
    onClear: LogPanelProps['onClear'];
    activeConnectionIds: LogPanelProps['activeConnectionIds'];
    connectionLabels: LogPanelProps['connectionLabels'];
    showTimestamps: boolean;
    onToggleTimestamps: () => unknown;
  };
}

export default function TransferLogSection({
  windowNarrow,
  showTransferQueue,
  logEnabled,
  resizingSection,
  startSectionResize,
  resetSectionHeight,
  transferLogRef,
  transferQueueHeight,
  logPanelHeight,
  transferManuallyResized,
  logManuallyResized,
  transferLogSplitRatio,
  resizingTransferLog,
  startTransferLogResize,
  resetTransferLogSplitRatio,
  transfersEmpty,
  logEmpty,
  transfer,
  log,
}: TransferLogSectionProps) {
  const { t } = useTranslation();

  if (windowNarrow && showTransferQueue && logEnabled) {
    return (
      <>
        <div
          className={`section-resizer ${resizingSection === 'transfers' ? 'dragging' : ''}`}
          onMouseDown={startSectionResize('transfers')}
          onDoubleClick={() => {
            resetSectionHeight('transfers')();
            resetSectionHeight('log')();
          }}
          data-tooltip={t('resize.height')}
        />
        <div
          className="narrow-sections"
          ref={transferLogRef}
          style={{
            flex: `0 0 ${Math.max(
              transfersEmpty && !transferManuallyResized
                ? TRANSFER_HEADER_HEIGHT_NARROW
                : transferQueueHeight,
              logEmpty && !logManuallyResized ? LOG_HEADER_HEIGHT_NARROW : logPanelHeight,
            )}px`,
          }}
        >
          <ErrorBoundary local style={{ flex: `${transferLogSplitRatio} 1 0%` }}>
            <TransferQueue
              onRetry={transfer.onRetry}
              onPause={transfer.onPause}
              onStop={transfer.onStop}
              onClearCompleted={transfer.onClearCompleted}
              connectionLabels={transfer.connectionLabels}
              narrow
              widthRatio={transferLogSplitRatio}
              columnWidths={transfer.columnWidths}
              onColumnWidthsChange={transfer.onColumnWidthsChange}
              columnOrder={transfer.columnOrder}
              onColumnOrderChange={transfer.onColumnOrderChange}
            />
          </ErrorBoundary>
          <div
            className={`pane-resizer ${resizingTransferLog ? 'dragging' : ''}`}
            onMouseDown={startTransferLogResize}
            onDoubleClick={resetTransferLogSplitRatio}
            data-tooltip={t('resize.ratio')}
          />
          <LogPanel
            lines={log.lines}
            onClear={log.onClear}
            narrow
            widthRatio={1 - transferLogSplitRatio}
            activeConnectionIds={log.activeConnectionIds}
            connectionLabels={log.connectionLabels}
            showTimestamps={log.showTimestamps}
            onToggleTimestamps={log.onToggleTimestamps}
          />
        </div>
      </>
    );
  }

  return (
    <>
      {showTransferQueue && (
        <>
          <div
            className={`section-resizer ${resizingSection === 'transfers' ? 'dragging' : ''}`}
            onMouseDown={startSectionResize('transfers')}
            onDoubleClick={resetSectionHeight('transfers')}
            data-tooltip={t('resize.height')}
          />
          <ErrorBoundary local style={{ flex: `0 0 ${transferQueueHeight}px` }}>
            <TransferQueue
              onRetry={transfer.onRetry}
              onPause={transfer.onPause}
              onStop={transfer.onStop}
              onClearCompleted={transfer.onClearCompleted}
              connectionLabels={transfer.connectionLabels}
              height={transferQueueHeight}
              narrow={windowNarrow}
              columnWidths={transfer.columnWidths}
              onColumnWidthsChange={transfer.onColumnWidthsChange}
              columnOrder={transfer.columnOrder}
              onColumnOrderChange={transfer.onColumnOrderChange}
            />
          </ErrorBoundary>
        </>
      )}
      {logEnabled && (
        <>
          <div
            className={`section-resizer ${resizingSection === 'log' ? 'dragging' : ''}`}
            onMouseDown={startSectionResize('log')}
            onDoubleClick={resetSectionHeight('log')}
            data-tooltip={t('resize.height')}
          />
          <LogPanel
            lines={log.lines}
            onClear={log.onClear}
            height={logPanelHeight}
            narrow={windowNarrow}
            activeConnectionIds={log.activeConnectionIds}
            connectionLabels={log.connectionLabels}
            showTimestamps={log.showTimestamps}
            onToggleTimestamps={log.onToggleTimestamps}
          />
        </>
      )}
    </>
  );
}
