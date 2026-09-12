import {
  memo,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { flashTooltip } from '../../hooks/useTooltip.ts';
import { useTruncated } from '../../hooks/useTruncated.ts';
import ContextMenu from '../../components/ContextMenu.tsx';
import Icon from '../../components/Icon.tsx';
import { LOG_HEADER_HEIGHT, LOG_HEADER_HEIGHT_NARROW } from '../../shared/layoutMetrics.ts';
import type { LogEntry, Translate } from '../../shared/types.ts';
import { handler } from '../../shared/asyncFailure.ts';
import { api } from '../../platform/api/index.ts';
import type { LogTimeFormatter } from '../settings/index.ts';

interface LogPanelProps {
  lines: readonly LogEntry[];
  onClear: () => void;
  height?: number | undefined;
  narrow?: boolean | undefined;
  widthRatio?: number | undefined;
  activeConnectionIds?: ReadonlySet<string | null> | undefined;
  connectionLabels?: ReadonlyMap<string | null, string> | undefined;
  showTimestamps: boolean;
  formatTime: LogTimeFormatter;
}

// How close to the bottom (in px) still counts as "at the bottom" — exact
// equality is too strict since sub-pixel scroll positions are common.
const STICK_TO_BOTTOM_THRESHOLD = 24;

// What the backend accepts from "Save"; the newest lines that fit are kept.
const SAVE_BYTE_LIMIT = 2 * 1024 * 1024;

// Lines render in blocks of records numbered alike. A new batch re-renders
// only the last block and trimming only the first; the browser skips layout
// and paint for blocks off screen (`content-visibility: auto`), which lets the
// panel hold thousands of lines whose height depends on how they wrap.
const CHUNK_SIZE = 100;

const KIND_MENU_WIDTH = 200;

const LOG_KINDS = ['status', 'command', 'response', 'error'] as const;
type LogKindName = (typeof LOG_KINDS)[number];
const KIND_LABEL_KEYS: Record<LogKindName, string> = {
  status: 'logPanel.kindStatus',
  command: 'logPanel.kindCommand',
  response: 'logPanel.kindResponse',
  error: 'logPanel.kindError',
};

function kindOf(entry: LogEntry): LogKindName {
  return (LOG_KINDS as readonly string[]).includes(entry.kind)
    ? (entry.kind as LogKindName)
    : 'status';
}

function resolveLine(entry: LogEntry, t: Translate): string {
  if (!entry.key) return entry.line ?? '';
  return entry.params ? t(`log.${entry.key}`, entry.params) : t(`log.${entry.key}`);
}

function formatLines(
  entries: readonly LogEntry[],
  showTags: boolean,
  getLabel: (entry: LogEntry) => string,
  formatTime: LogTimeFormatter,
  t: Translate,
): string {
  return entries
    .map((entry) => {
      const tag = showTags && entry.connectionId ? `${getLabel(entry)}: ` : '';
      return `${formatTime.dateTime(entry.ts)} ${tag}${resolveLine(entry, t)}`;
    })
    .join('\n');
}

/** The newest lines whose text fits in `limit` bytes of UTF-8. */
function newestThatFit(text: string, limit: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= limit) return text;
  const lines = text.split('\n');
  let bytes = 0;
  let start = lines.length;
  while (start > 0) {
    const size = encoder.encode(lines[start - 1]).length + 1;
    if (bytes + size > limit) break;
    bytes += size;
    start -= 1;
  }
  return lines.slice(start).join('\n');
}

// Resizing moves the panel's top edge, and the lines stay where they are on
// screen while it slides over them or uncovers older ones, as in a terminal.
// Only with no older line left to uncover do they follow the edge down.
interface ScrollState {
  /** Following the newest line, at the bottom. */
  stuck: boolean;
  /**
   * How far into the lines the view's bottom edge reaches, as the user left
   * it. Resizing never changes it, so folding the panel away and opening it
   * again, or pressing it up against the first line and back, puts every line
   * back where it was.
   */
  bottom: number;
  /** Where the panel last scrolled itself to. */
  placed: number | null;
}

function placeView(el: HTMLElement, state: ScrollState): void {
  if (state.stuck) {
    const dpr = window.devicePixelRatio || 1;
    el.scrollTop = Math.round(el.scrollHeight * dpr) / dpr;
  } else {
    el.scrollTop = state.bottom - el.clientHeight;
  }
  state.placed = el.scrollTop;
}

interface LogChunkProps {
  lines: readonly LogEntry[];
  /** Everything besides the lines themselves that changes what they show. */
  renderKey: string;
  formatTime: LogTimeFormatter;
  t: Translate;
  estimatedLineHeight: number;
  renderLine: (entry: LogEntry) => ReactNode;
}

const LogChunk = memo(
  function LogChunk({ lines, estimatedLineHeight, renderLine }: LogChunkProps) {
    return (
      <div
        className="log-chunk"
        style={{ containIntrinsicSize: `auto ${lines.length * estimatedLineHeight}px` }}
      >
        {lines.map(renderLine)}
      </div>
    );
  },
  // Records never change once written and are numbered in order, so the
  // same first, last and count mean the same lines.
  (previous, next) =>
    previous.renderKey === next.renderKey &&
    previous.formatTime === next.formatTime &&
    previous.t === next.t &&
    previous.lines.length === next.lines.length &&
    previous.lines[0]?.seq === next.lines[0]?.seq &&
    previous.lines.at(-1)?.seq === next.lines.at(-1)?.seq,
);

export default function LogPanel({
  lines,
  onClear,
  height,
  narrow,
  widthRatio,
  activeConnectionIds,
  connectionLabels,
  showTimestamps,
  formatTime,
}: LogPanelProps) {
  const { t } = useTranslation();
  const bodyRef = useRef<HTMLDivElement>(null);
  // `connectionLabels` keeps closed connections' labels too (the app remembers
  // them, across an interface reload as well). Should one still be missing,
  // the backend's name for its server stands in.
  const getLabel = (entry: Pick<LogEntry, 'connectionId' | 'server'>): string =>
    connectionLabels?.get(entry.connectionId) || entry.server || '?';

  // Clicking a connection tag isolates that connection's lines; clicking the
  // same one again (or its header pill) returns to showing everything.
  const [filterConnection, setFilterConnection] = useState<Pick<
    LogEntry,
    'connectionId' | 'server'
  > | null>(null);
  const filterConnectionId = filterConnection?.connectionId ?? null;
  const [filterPillLabelRef, filterPillLabelTruncated] = useTruncated<HTMLSpanElement>([
    filterConnectionId,
  ]);
  const toggleFilter = (entry: LogEntry) => {
    setFilterConnection((previous) =>
      previous?.connectionId === entry.connectionId ? null : entry,
    );
  };

  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<LogKindName>>(() => new Set());
  const [kindMenu, setKindMenu] = useState<{ x: number; y: number; aboveY: number } | null>(null);
  const toggleKind = (kind: LogKindName) => {
    setHiddenKinds((previous) => {
      const next = new Set(previous);
      if (!next.delete(kind)) next.add(kind);
      return next;
    });
  };

  // The search field stays open beside the title. In the narrow layout it is
  // a button instead, whose field covers the buttons, as the file panes'
  // search covers their toolbar; closing it drops the search, so nothing
  // stays filtered out of sight.
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searchFieldShown = !narrow || searchOpen || search !== '';
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);
  const closeSearch = () => {
    setSearchOpen(false);
    setSearch('');
  };
  const query = useDeferredValue(search.trim().toLowerCase());

  const visibleLines = useMemo(
    () =>
      filterConnectionId || hiddenKinds.size > 0 || query
        ? lines.filter(
            (entry) =>
              (!filterConnectionId || entry.connectionId === filterConnectionId) &&
              !hiddenKinds.has(kindOf(entry)) &&
              (!query || resolveLine(entry, t).toLowerCase().includes(query)),
          )
        : lines,
    [lines, filterConnectionId, hiddenKinds, query, t],
  );
  const narrowedByKindOrSearch = hiddenKinds.size > 0 || query !== '';

  const chunks = useMemo(() => {
    const result: Array<{ key: number; lines: LogEntry[] }> = [];
    for (const entry of visibleLines) {
      const key = Math.floor(entry.seq / CHUNK_SIZE);
      const last = result.at(-1);
      if (last?.key === key) last.lines.push(entry);
      else result.push({ key, lines: [entry] });
    }
    return result;
  }, [visibleLines]);

  const scrollRef = useRef<ScrollState>({ stuck: true, bottom: 0, placed: null });

  const handleScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const state = scrollRef.current;
    // The panel's own scrolling is not where the user left the lines.
    if (state.placed != null && Math.abs(el.scrollTop - state.placed) < 1) return;
    state.placed = null;
    state.bottom = el.scrollTop + el.clientHeight;
    state.stuck = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_THRESHOLD;
  };

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && scrollRef.current.stuck) placeView(el, scrollRef.current);
  }, [visibleLines]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => placeView(el, scrollRef.current));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const lineProbeRef = useRef<HTMLDivElement>(null);
  const [lineHeight, setLineHeight] = useState(14);
  useLayoutEffect(() => {
    const probe = lineProbeRef.current;
    const body = bodyRef.current;
    if (!probe || !body) return;
    const measure = () => {
      const dpr = window.devicePixelRatio || 1;
      const h = probe.getBoundingClientRect().height;
      if (h <= 0) return;
      const snapped = Math.round(h * dpr) / dpr;
      body.style.lineHeight = `${snapped}px`;
      setLineHeight((previous) => (Math.abs(previous - snapped) > 0.5 ? snapped : previous));
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

  const showConnectionTags = useMemo(
    () => new Set(lines.map((l) => l.connectionId).filter(Boolean)).size > 1,
    [lines],
  );

  // Labels and open/closed state as one value, so blocks re-render when a tab
  // is renamed or a connection closes, and not on every unrelated pane update.
  const connectionStateKey = useMemo(
    () =>
      [...(connectionLabels ?? [])]
        .map(([id, label]) => `${id}${label}${activeConnectionIds?.has(id) ? 1 : 0}`)
        .join(''),
    [connectionLabels, activeConnectionIds],
  );
  // Filters belong here too: a different query can keep a block's first line,
  // last line and count while changing the lines in between.
  const renderKey = [
    showTimestamps,
    showConnectionTags,
    filterConnectionId,
    [...hiddenKinds].join(','),
    query,
    connectionStateKey,
  ].join('');

  const handleCopy = async (e: MouseEvent<HTMLButtonElement>) => {
    // React nulls currentTarget once the handler yields, so grab it before the await.
    const anchor = e.currentTarget;
    try {
      await navigator.clipboard.writeText(
        formatLines(visibleLines, showConnectionTags, getLabel, formatTime, t),
      );
      flashTooltip(anchor, t('logPanel.copiedTooltip'));
    } catch {
      flashTooltip(anchor, t('logPanel.copyFailedTooltip'));
    }
  };

  const handleSave = async (e: MouseEvent<HTMLButtonElement>) => {
    const anchor = e.currentTarget;
    const content = newestThatFit(
      formatLines(visibleLines, showConnectionTags, getLabel, formatTime, t),
      SAVE_BYTE_LIMIT,
    );
    const res = await api.log.save(content);
    if (!res.ok && !res.canceled) flashTooltip(anchor, t('logPanel.saveFailedTooltip'));
  };

  const renderLine = (entry: LogEntry) => {
    const isOpen = !!entry.connectionId && activeConnectionIds?.has(entry.connectionId);
    const isFiltered = entry.connectionId === filterConnectionId;
    return (
      <div key={entry.seq} className={`log-line log-line-${entry.kind || 'status'}`}>
        {showTimestamps && <span className="log-line-time">{formatTime.time(entry.ts)}</span>}
        {showConnectionTags && entry.connectionId && (
          <>
            {/* The space after the colon stays outside the tag, so a closed
                connection's strike-through stops at the colon. */}
            <span
              className={`log-line-conn-tag ${isOpen ? '' : 'closed'}`}
              data-tooltip={
                isFiltered
                  ? t('logPanel.showAllConnections')
                  : isOpen
                    ? t('logPanel.showOnlyThisConnection')
                    : t('logPanel.connectionClosedShowOnly')
              }
              onClick={() => toggleFilter(entry)}
            >
              {getLabel(entry)}:
            </span>{' '}
          </>
        )}
        {resolveLine(entry, t)}
      </div>
    );
  };

  const emptyMessage =
    lines.length === 0
      ? t('logPanel.emptyDefault')
      : narrowedByKindOrSearch
        ? t('logPanel.emptyNoMatches')
        : t('logPanel.emptyFiltered');

  return (
    <div className={`log-panel ${narrow ? 'narrow' : ''}`} style={rootStyle}>
      {/* The title, kind filter and search at the line's start, then the
          connection filter pill; the other buttons at its end. */}
      <div className="section-panel-header log-panel-header">
        <span className="log-panel-title">{t('menu.view.log')}</span>
        <span className="toolbar-divider" />
        {!(narrow && searchFieldShown) && (
          <button
            type="button"
            className="btn btn-ghost btn-icon header-icon-btn"
            data-tooltip={t('logPanel.filterKinds')}
            aria-haspopup="menu"
            aria-expanded={kindMenu !== null}
            // The open menu closes on any press outside it; this button's press
            // is left to its click, which closes the menu instead of reopening it.
            onMouseDown={(event) => {
              if (kindMenu) event.stopPropagation();
            }}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              // The button sits at the header's start, so the menu lines up with
              // its start edge and opens back over the log.
              const x = document.documentElement.dir === 'rtl' ? rect.right : rect.left;
              setKindMenu((open) =>
                open ? null : { x, y: rect.bottom + 2, aboveY: rect.top - 2 },
              );
            }}
          >
            <Icon name="funnel" size={12} />
          </button>
        )}
        {narrow && (
          <button
            type="button"
            className={`btn btn-ghost btn-icon header-icon-btn ${searchFieldShown ? 'active' : ''}`}
            data-tooltip={t('logPanel.searchPlaceholder')}
            aria-expanded={searchFieldShown}
            onClick={() => (searchFieldShown ? closeSearch() : setSearchOpen(true))}
          >
            <Icon name="search" size={12} />
          </button>
        )}
        {searchFieldShown && (
          <label className="log-panel-search">
            {!narrow && <Icon name="search" size={11} />}
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              placeholder={t('logPanel.searchPlaceholder')}
              aria-label={t('logPanel.searchPlaceholder')}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                if (narrow) {
                  event.stopPropagation();
                  closeSearch();
                } else if (search) {
                  event.stopPropagation();
                  setSearch('');
                }
              }}
            />
          </label>
        )}
        {filterConnection && (
          <button
            type="button"
            className="log-panel-filter-pill"
            data-tooltip={t('logPanel.showAllConnections')}
            onClick={() => setFilterConnection(null)}
          >
            <span
              ref={filterPillLabelRef}
              className={`log-panel-filter-pill-label${filterPillLabelTruncated ? ' truncated' : ''}`}
            >
              {getLabel(filterConnection)}
            </span>
            <Icon name="windowClose" size={9} />
          </button>
        )}
        {!(narrow && searchFieldShown) && (
          <span className="log-panel-actions">
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
              data-tooltip={t('logPanel.saveToFile')}
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
        )}
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
          <div className="transfer-empty">{emptyMessage}</div>
        )}
        {/* Kept while the panel is folded down to its header, so opening it
            again finds each block the size it was and the lines where they were. */}
        {chunks.map((chunk) => (
          <LogChunk
            key={chunk.key}
            lines={chunk.lines}
            renderKey={renderKey}
            formatTime={formatTime}
            t={t}
            estimatedLineHeight={lineHeight}
            renderLine={renderLine}
          />
        ))}
      </div>
      {kindMenu &&
        createPortal(
          <ContextMenu
            {...kindMenu}
            width={KIND_MENU_WIDTH}
            onClose={() => setKindMenu(null)}
            items={LOG_KINDS.map((kind) => ({
              label: t(KIND_LABEL_KEYS[kind]),
              checked: !hiddenKinds.has(kind),
              onClick: () => toggleKind(kind),
            }))}
          />,
          document.body,
        )}
    </div>
  );
}
