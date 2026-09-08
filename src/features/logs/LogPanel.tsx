import { useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { flashTooltip } from '../../hooks/useTooltip.ts';
import { useTruncated } from '../../hooks/useTruncated.ts';
import Icon from '../../components/Icon.tsx';
import { LOG_HEADER_HEIGHT, LOG_HEADER_HEIGHT_NARROW } from '../../shared/layoutMetrics.ts';
import type { StampedLogEntry } from './useLogLines.ts';
import type { LogEntry, Translate } from '../../shared/types.ts';
import { handler } from '../../shared/asyncFailure.ts';
import { api } from '../../platform/api/index.ts';

interface LogPanelProps {
  lines: Array<StampedLogEntry<LogEntry>>;
  onClear: () => void;
  height?: number | undefined;
  narrow?: boolean | undefined;
  widthRatio?: number | undefined;
  activeConnectionIds?: ReadonlySet<string | null> | undefined;
  connectionLabels?: ReadonlyMap<string | null, string> | undefined;
  showTimestamps: boolean;
  onToggleTimestamps: () => void;
}

// How close to the bottom (in px) still counts as "at the bottom" — exact
// equality is too strict since sub-pixel scroll positions are common.
const STICK_TO_BOTTOM_THRESHOLD = 24;

const SAVE_LINE_LIMIT = 200;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function resolveLine(entry: LogEntry, t: Translate): string {
  if (!entry.key) return entry.line ?? '';
  return entry.params ? t(`log.${entry.key}`, entry.params) : t(`log.${entry.key}`);
}

function formatLines(
  entries: Array<StampedLogEntry<LogEntry>>,
  showTags: boolean,
  getLabel: (connectionId: string) => string,
  t: Translate,
): string {
  return entries
    .map((entry) => {
      const tag = showTags && entry.connectionId ? `${getLabel(entry.connectionId)}: ` : '';
      return `${formatTimestamp(entry.ts)} ${tag}${resolveLine(entry, t)}`;
    })
    .join('\n');
}

export default function LogPanel({
  lines,
  onClear,
  height,
  narrow,
  widthRatio,
  activeConnectionIds,
  connectionLabels,
  showTimestamps,
  onToggleTimestamps,
}: LogPanelProps) {
  const { t } = useTranslation();
  const bodyRef = useRef<HTMLDivElement>(null);
  const labelCacheRef = useRef(new Map<string, string>());
  if (connectionLabels) {
    for (const [id, label] of connectionLabels) {
      if (id) labelCacheRef.current.set(id, label);
    }
  }
  const getLabel = (connectionId: string): string => labelCacheRef.current.get(connectionId) || '?';

  // Clicking a connection tag isolates that connection's lines; clicking the
  // same one again (or its header pill) returns to showing everything.
  const [filterConnectionId, setFilterConnectionId] = useState<string | null>(null);
  const [filterPillLabelRef, filterPillLabelTruncated] = useTruncated<HTMLSpanElement>([
    filterConnectionId,
  ]);
  const toggleFilter = (connectionId: string) => {
    setFilterConnectionId((prev) => (prev === connectionId ? null : connectionId));
  };
  const visibleLines = filterConnectionId
    ? lines.filter((l) => l.connectionId === filterConnectionId)
    : lines;

  const stickToBottomRef = useRef(true);

  const lastClientHeightRef = useRef<number | null>(null);

  const handleScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    // null (no scroll event accepted yet) never counts as a resize — only an
    // actual mismatch against a previously-recorded height does.
    const resized =
      lastClientHeightRef.current != null && el.clientHeight !== lastClientHeightRef.current;
    lastClientHeightRef.current = el.clientHeight;
    if (resized) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_THRESHOLD;
  };

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (!stickToBottomRef.current) return;
    const dpr = window.devicePixelRatio || 1;
    el.scrollTop = Math.round(el.scrollHeight * dpr) / dpr;
  }, [visibleLines, height]);

  const lineProbeRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const probe = lineProbeRef.current;
    const body = bodyRef.current;
    if (!probe || !body) return;
    const measure = () => {
      const dpr = window.devicePixelRatio || 1;
      const h = probe.getBoundingClientRect().height;
      if (h > 0) body.style.lineHeight = `${Math.round(h * dpr) / dpr}px`;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(probe);
    return () => ro.disconnect();
  }, []);

  const rootStyle =
    widthRatio != null ? { flex: `${widthRatio} 1 0%`, minWidth: 0 } : { flex: `0 0 ${height}px` };

  const isCollapsed =
    height != null && height <= (narrow ? LOG_HEADER_HEIGHT_NARROW : LOG_HEADER_HEIGHT);

  const showConnectionTags = new Set(lines.map((l) => l.connectionId).filter(Boolean)).size > 1;

  const handleCopy = async (e: MouseEvent<HTMLButtonElement>) => {
    try {
      await navigator.clipboard.writeText(
        formatLines(visibleLines, showConnectionTags, getLabel, t),
      );
      flashTooltip(e.currentTarget, t('logPanel.copiedTooltip'));
    } catch {
      flashTooltip(e.currentTarget, t('logPanel.copyFailedTooltip'));
    }
  };

  const handleSave = async (e: MouseEvent<HTMLButtonElement>) => {
    const anchor = e.currentTarget;
    const content = formatLines(
      visibleLines.slice(-SAVE_LINE_LIMIT),
      showConnectionTags,
      getLabel,
      t,
    );
    const res = await api.log.save(content);
    if (!res.ok && !res.canceled) flashTooltip(anchor, t('logPanel.saveFailedTooltip'));
  };

  return (
    <div className={`log-panel ${narrow ? 'narrow' : ''}`} style={rootStyle}>
      <div className="section-panel-header log-panel-header">
        <span className="log-panel-header-left">
          <span>{t('menu.view.log')}</span>
          {filterConnectionId && (
            <button
              type="button"
              className="log-panel-filter-pill"
              data-tooltip={t('logPanel.showAllConnections')}
              onClick={() => setFilterConnectionId(null)}
            >
              <span
                ref={filterPillLabelRef}
                className={`log-panel-filter-pill-label${filterPillLabelTruncated ? ' truncated' : ''}`}
              >
                {getLabel(filterConnectionId)}
              </span>
              <Icon name="windowClose" size={9} />
            </button>
          )}
        </span>
        <span className="transfer-queue-header-right">
          <button
            type="button"
            className={`btn btn-ghost btn-icon header-icon-btn ${showTimestamps ? 'active' : ''}`}
            data-tooltip={
              showTimestamps ? t('logPanel.hideTimestamps') : t('logPanel.showTimestamps')
            }
            onClick={onToggleTimestamps}
          >
            <Icon name="clock" size={12} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon header-icon-btn"
            data-tooltip={t('logPanel.copyToClipboard')}
            onClick={handler(handleCopy)}
            disabled={visibleLines.length === 0}
          >
            <Icon name="copy" size={12} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon header-icon-btn"
            data-tooltip={t('logPanel.saveLastLines', { count: SAVE_LINE_LIMIT })}
            onClick={handler(handleSave)}
            disabled={visibleLines.length === 0}
          >
            <Icon name="save" size={12} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon header-icon-btn"
            data-tooltip={t('logPanel.clearLog')}
            onClick={onClear}
            disabled={lines.length === 0}
          >
            <Icon name="broom" size={12} />
          </button>
        </span>
      </div>
      <div className="log-panel-body" ref={bodyRef} onScroll={handleScroll}>
        {/* Hidden always-mounted probe for the line-height snapping above —
            pinned to the CSS-authored 1.3 ratio regardless of what the
            measurement effect sets on .log-panel-body itself. */}
        <div
          ref={lineProbeRef}
          aria-hidden="true"
          className="log-line"
          style={{
            position: 'absolute',
            visibility: 'hidden',
            pointerEvents: 'none',
            top: -9999,
            left: -9999,
            lineHeight: 1.3,
          }}
        >
          Probe
        </div>
        {!isCollapsed && visibleLines.length === 0 && (
          <div className="transfer-empty">
            {filterConnectionId ? t('logPanel.emptyFiltered') : t('logPanel.emptyDefault')}
          </div>
        )}
        {!isCollapsed &&
          visibleLines.map((entry) => {
            const isOpen = !!entry.connectionId && activeConnectionIds?.has(entry.connectionId);
            const isFiltered = entry.connectionId === filterConnectionId;
            return (
              <div key={entry.id} className={`log-line log-line-${entry.kind || 'status'}`}>
                {showTimestamps && (
                  <span className="log-line-time">{formatTimestamp(entry.ts)}</span>
                )}
                {showConnectionTags && entry.connectionId && (
                  <span
                    className={`log-line-conn-tag ${isOpen ? '' : 'closed'}`}
                    data-tooltip={
                      isFiltered
                        ? t('logPanel.showAllConnections')
                        : isOpen
                          ? t('logPanel.showOnlyThisConnection')
                          : t('logPanel.connectionClosedShowOnly')
                    }
                    onClick={() => toggleFilter(entry.connectionId)}
                  >
                    {getLabel(entry.connectionId)}:{' '}
                  </span>
                )}
                {resolveLine(entry, t)}
              </div>
            );
          })}
      </div>
    </div>
  );
}
