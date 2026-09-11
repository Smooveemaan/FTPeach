import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatBytes, formatSpeed, formatDuration } from '../../../shared/format.ts';
import { isolate } from '../../../shared/bidi.ts';
import { fileIconName } from '../../../shared/fileIcons.ts';
import Icon from '../../../components/Icon.tsx';
import { useTruncated } from '../../../hooks/useTruncated.ts';
import { updateSpeedSample } from '../transferSpeed.ts';
import type { SpeedSamples } from '../transferSpeed.ts';
import { canRetryTransfer, type TransferRow } from '../transferStore.ts';
import type { ReorderableColumnKey } from '../transferColumns.ts';
import {
  STATUS_LABEL_KEY,
  PROGRESS_LABEL_KEY,
  DIR_ICON,
  DIR_TITLE_KEY,
  pauseUnsupportedKey,
  transferRoute,
  transferRoutePlaces,
  transferRouteTooltip,
} from '../transferPresentation.ts';
interface TransferItemRowProps {
  item: TransferRow;
  /** The name a connection's server goes by, including one already closed. */
  connectionLabel: (connectionId: string) => string;
  columnOrder: readonly ReorderableColumnKey[];
  gridTemplateColumns: string;
  speedSamples: SpeedSamples;
  onRetry: (id: string) => void;
  onPause: (id: string) => void;
  onStop: (id: string) => void;
}

function RouteEndpoint({ name }: { name: string }) {
  const [nameRef, nameTruncated] = useTruncated<HTMLElement>([name]);
  return (
    <bdi ref={nameRef} className={`t-route-name${nameTruncated ? ' truncated' : ''}`}>
      {name}
    </bdi>
  );
}

export default function TransferItemRow({
  item,
  connectionLabel,
  columnOrder,
  gridTemplateColumns,
  speedSamples,
  onRetry,
  onPause,
  onStop,
}: TransferItemRowProps) {
  const { t } = useTranslation();
  const isDirectory = item.direction === 'recursive' || (item.dragOut && item.isDirectory);
  const route = transferRoute(item);
  const moving = item.direction === 'recursive' && item.intent.moving;
  const fullPath =
    item.direction === 'recursive'
      ? item.intent.source.path
      : item.direction === 'up'
        ? item.localFile
        : item.direction === 'down'
          ? item.remoteFile
          : item.sourcePath;
  const displayName = isDirectory
    ? fullPath
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop() || fullPath
    : item.name;
  const total = item.total ?? 0;
  const hasTotal = total > 0;
  const percent = hasTotal ? Math.min(100, Math.round((item.bytes / total) * 100)) : null;
  const showBar = hasTotal && item.status !== 'error';
  const pauseUnsupported = pauseUnsupportedKey(item);
  const retryUnsupported = !canRetryTransfer(item);
  const speed = updateSpeedSample(speedSamples, item.id, item.bytes, item.status);
  const remaining =
    item.status === 'progress' && hasTotal && speed && speed > 0
      ? (total - item.bytes) / speed
      : null;
  const subText =
    item.status === 'error' && item.errorMessage
      ? item.errorMessage
      : item.status === 'stopped'
        ? t('transferQueue.cancelledByUser')
        : null;
  const statusLabel = t(
    item.status === 'progress'
      ? moving
        ? 'dragMove.moveMode'
        : PROGRESS_LABEL_KEY[route]
      : STATUS_LABEL_KEY[item.status],
  );
  const [from, to] = transferRoutePlaces(item, connectionLabel, t);
  const routeText = t('transferQueue.route', { from: isolate(from), to: isolate(to) });

  const [nameRef, nameTruncated] = useTruncated<HTMLSpanElement>([item.name]);
  const [subRef, subTruncated] = useTruncated<HTMLSpanElement>([subText]);
  const [sizeRef, sizeTruncated] = useTruncated<HTMLSpanElement>([total, item.bytes]);
  const [transferredRef, transferredTruncated] = useTruncated<HTMLSpanElement>([item.bytes]);
  const [speedRef, speedTruncated] = useTruncated<HTMLDivElement>([speed, item.status]);
  const [remainRef, remainTruncated] = useTruncated<HTMLDivElement>([remaining, item.status]);

  const renderCell = (key: ReorderableColumnKey): ReactNode => {
    switch (key) {
      case 'route':
        return (
          <div
            key={key}
            data-column-cell={key}
            className="t-route"
            aria-label={routeText}
            data-tooltip={transferRouteTooltip(item, connectionLabel, t)}
          >
            <RouteEndpoint name={from} />
            <span className="t-route-arrow" aria-hidden="true">
              →
            </span>
            <RouteEndpoint name={to} />
          </div>
        );
      case 'size':
        return (
          <div key={key} data-column-cell={key} className="t-size">
            <span ref={sizeRef} className={sizeTruncated ? 'truncated' : ''}>
              {formatBytes(hasTotal ? total : item.bytes)}
            </span>
          </div>
        );
      case 'transferred':
        return (
          <div key={key} data-column-cell={key} className="t-transferred">
            <span ref={transferredRef} className={transferredTruncated ? 'truncated' : ''}>
              {formatBytes(item.bytes)}
            </span>
          </div>
        );
      case 'progress':
        return showBar ? (
          <div key={key} data-column-cell={key} className="t-progress">
            <div
              className="p-track"
              role="progressbar"
              aria-label={item.name}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? undefined}
            >
              <div
                className={`p-fill status-${item.status}`}
                style={{ width: `${percent ?? 0}%` }}
              />
            </div>
            <span className="p-pct">{percent}%</span>
          </div>
        ) : (
          <div key={key} data-column-cell={key} className="t-progress no-bar">
            <span className="dash">
              {item.status === 'error' ? t('transferQueue.stoppedDash') : '—'}
            </span>
          </div>
        );
      case 'speed':
        return (
          <div
            key={key}
            data-column-cell={key}
            ref={speedRef}
            className={`t-speed${speedTruncated ? ' truncated' : ''}`}
          >
            {item.status === 'progress' ? formatSpeed(speed) : <span className="dash">—</span>}
          </div>
        );
      case 'remaining':
        return (
          <div
            key={key}
            ref={remainRef}
            data-column-cell={key}
            className={`t-remain${remainTruncated ? ' truncated' : ''}`}
          >
            {item.status === 'progress' ? (
              formatDuration(remaining)
            ) : (
              <span className="dash">—</span>
            )}
          </div>
        );
      case 'status':
        return (
          <div key={key} data-column-cell={key} className="t-status">
            <span className={`status-tag ${item.status}`}>{statusLabel}</span>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div
      className="transfer-item transfer-cols"
      style={{ gridTemplateColumns }}
      role="group"
      aria-label={`${isolate(item.name)}: ${statusLabel}${percent == null ? '' : `, ${percent}%`}`}
    >
      <div className="t-file">
        <span
          className={`dir-icon dir-${route}`}
          data-tooltip={t(moving ? 'dragMove.moveMode' : DIR_TITLE_KEY[route])}
        >
          <Icon name={moving ? 'arrowLeftRight' : DIR_ICON[route]} size={13} />
        </span>
        <span className={`transfer-file-icon${isDirectory ? ' is-folder' : ''}`}>
          <Icon name={fileIconName({ name: displayName, isDirectory: !!isDirectory })} size={13} />
        </span>
        <div className="t-name-wrap">
          <span
            ref={nameRef}
            className={`t-name${nameTruncated ? ' truncated' : ''}`}
            data-tooltip={fullPath}
          >
            <bdi>{displayName}</bdi>
          </span>
          {subText && (
            <span
              ref={subRef}
              className={`t-sub ${item.status === 'error' ? 'err' : ''}${subTruncated ? ' truncated' : ''}`}
              data-tooltip={subText}
            >
              <bdi>{subText}</bdi>
            </span>
          )}
        </div>
      </div>
      {columnOrder.map((key) => renderCell(key))}
      <div className="transfer-actions">
        {item.status !== 'done' && (
          <>
            {item.status === 'paused' && (
              <button
                type="button"
                className="retry-btn"
                data-tooltip={t('transferQueue.resume')}
                onClick={() => onRetry(item.id)}
              >
                <Icon name="play" size={11} />
              </button>
            )}
            {(item.status === 'progress' || item.status === 'queued') && !item.dragOut && (
              <button
                type="button"
                className="pause-btn"
                data-tooltip={t(pauseUnsupported ?? 'transferQueue.status.paused')}
                disabled={pauseUnsupported !== null}
                onClick={() => onPause(item.id)}
              >
                <Icon name="pause" size={11} />
              </button>
            )}
            {(item.status === 'error' || item.status === 'stopped') && !item.dragOut && (
              <button
                type="button"
                className="retry-btn"
                data-tooltip={
                  retryUnsupported
                    ? t('transferQueue.retryUnsupportedConnection')
                    : t('transferQueue.retry')
                }
                disabled={retryUnsupported}
                onClick={() => onRetry(item.id)}
              >
                <Icon name="play" size={11} />
              </button>
            )}
            {(item.status === 'progress' || item.status === 'queued' || item.status === 'paused') &&
              !(item.dragOut && item.isDirectory) && (
                <button
                  type="button"
                  className="stop-btn"
                  data-tooltip={t('transferQueue.stop')}
                  onClick={() => onStop(item.id)}
                >
                  <Icon name="stop" size={11} />
                </button>
              )}
          </>
        )}
      </div>
      <div className="col-filler" />
    </div>
  );
}
