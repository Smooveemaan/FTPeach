import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  HTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { Modifier } from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import Icon from '../../components/Icon.tsx';
import type { IconName } from '../../components/Icon.tsx';
import { getInterfaceScale } from '../../platform/interfaceScale.ts';
import type { ManagedSite, PaneId, PaneStatus, Translate } from '../../shared/types.ts';
import type { TabState } from './panes/paneModel.ts';

const PANE_IDS: readonly PaneId[] = ['a', 'b'];

// `ch` undershoots proportional fonts (e.g. "New Tab" > 8ch); measure the rename input's actual rendered width.
let measureCanvas: HTMLCanvasElement | null = null;
function measureTextWidth(text: string, font: string): number {
  measureCanvas ??= document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d');
  if (!ctx) return text.length * 7;
  ctx.font = font;
  return ctx.measureText(text).width;
}

type TabVisualStatus = PaneStatus | null;

interface TabDescription {
  label: string;
  status: TabVisualStatus;
  icon: string;
  color: string;
}

interface EditingTab {
  id: string;
  value: string;
}

interface SortableTabProps extends Omit<HTMLAttributes<HTMLDivElement>, 'id'> {
  id: string;
  disabled?: boolean;
  tabRef: (element: HTMLDivElement | null) => void;
  style?: CSSProperties;
  className?: string;
  children: ReactNode;
}

interface TabStripProps {
  tabs: readonly TabState[];
  activeTabId: string;
  onSelect: (id: string) => unknown;
  onClose: (id: string) => unknown;
  onNew: () => unknown;
  onRename?: (id: string, name: string) => unknown;
  onReorder?: (activeId: string, overId: string) => unknown;
  sites?: readonly ManagedSite[];
  colored?: boolean;
  disabled?: boolean;
  lastActivePaneId?: PaneId | null;
}

// Last segment of a local path, e.g. "C:\Users\foo\Documents" -> "Documents".
function localFolderLabel(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function describeTab(
  tab: TabState,
  t: Translate,
  sitesById: ReadonlyMap<string, ManagedSite>,
  lastActivePaneId: PaneId | null,
): TabDescription {
  const remotePanes = PANE_IDS.map((id) => tab.panes[id]).filter((p) => p.kind === 'remote');
  if (remotePanes.length === 0) {
    const activePane = tab.panes[lastActivePaneId || 'a'];
    const folderLabel = activePane.path ? localFolderLabel(activePane.path) : '';
    return {
      label: tab.name || folderLabel || t('tabStrip.localComputer'),
      status: null,
      icon: '',
      color: '',
    };
  }
  const rank: Partial<Record<PaneStatus, number>> = { connecting: 3, connected: 2, error: 1 };
  const best = remotePanes.reduce((a, b) =>
    (rank[b.status] || 0) > (rank[a.status] || 0) ? b : a,
  );
  const host =
    best.siteLabel || (best.form.protocol === 'webdav' ? best.form.webdavUrl : best.form.host);
  const savedSite = best.siteId ? sitesById.get(best.siteId) : null;
  return {
    label: tab.name || host || t('tabStrip.untitledTab'),
    icon: savedSite?.icon || '',
    color: savedSite?.color || '',
    status:
      best.status === 'connecting'
        ? 'connecting'
        : best.status === 'connected'
          ? 'connected'
          : best.status === 'error'
            ? 'error'
            : 'idle',
  };
}

const PAN_CLICK_THRESHOLD = 4;

const MIN_TAB_WIDTH = 76;
const MIN_TAB_WIDTH_COMPACT = 32;
const MAX_TAB_WIDTH = 134;
const TAB_GAP = 3;
const SCROLL_PADDING = 10; // .tab-strip-scroll's own left padding (no right padding — the "+" button's own margin provides that gap)
const ADD_BUTTON_SPACE = 40; // "+" button width + its margins on both sides
const ITEM_PADDING = 20; // .tab-strip-item's own 7px 10px padding, horizontal sum
const DOT_SPACE = 12; // status dot (6px) + the gap before the label (6px) — only tabs with a status dot pay this
const CLOSE_BUTTON_SPACE = 21; // close button (15px) + the gap before it (6px) — only paid once a 2nd tab makes closing possible

function SortableTab({
  id,
  disabled,
  tabRef,
  style,
  className,
  children,
  ...props
}: SortableTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id,
    disabled: disabled ?? false,
    transition: {
      duration: 220,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    },
  });
  const scale = getInterfaceScale();
  const localTransform = transform && {
    ...transform,
    x: transform.x / scale,
    y: transform.y / scale,
  };
  return (
    <div
      ref={(element) => {
        setNodeRef(element);
        tabRef(element);
      }}
      className={className}
      style={{
        ...style,
        transform: CSS.Translate.toString(localTransform),
        transition,
      }}
      {...attributes}
      {...listeners}
      {...props}
    >
      {children}
    </div>
  );
}

export default function TabStrip({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNew,
  onRename,
  onReorder,
  sites = [],
  colored = true,
  disabled,
  lastActivePaneId = null,
}: TabStripProps) {
  const { t } = useTranslation();
  const tabRefs = useRef<Array<HTMLDivElement | null>>([]);
  const labelRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [panning, setPanning] = useState(false);
  const [editing, setEditing] = useState<EditingTab | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const panStartXRef = useRef(0);
  const panStartScrollLeftRef = useRef(0);
  const draggedRef = useRef(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const restrictTabDrag: Modifier = useMemo(
    () =>
      ({ activeNodeRect, transform }) => {
        const strip = scrollRef.current;
        if (!strip || !activeNodeRect) return { ...transform, y: 0 };
        const viewport = strip.getBoundingClientRect();
        const scale = getInterfaceScale();
        const paddingLeft = (parseFloat(getComputedStyle(strip).paddingLeft) || 0) * scale;
        const rtl = document.documentElement.dir === 'rtl';
        const contentRight = rtl
          ? viewport.right - strip.scrollLeft * scale
          : viewport.left + (strip.scrollWidth - strip.scrollLeft) * scale;
        // Keep the dragged tab inside the visible left inset, even when the
        // strip is scrolled. Content bounds alone let it cross that inset.
        const minX = viewport.left + paddingLeft - activeNodeRect.left;
        const maxX = Math.max(minX, contentRight - activeNodeRect.right);
        return {
          ...transform,
          x: Math.min(maxX, Math.max(minX, transform.x)),
          y: 0,
        };
      },
    [],
  );

  const editingId = editing?.id;
  const editingValue = editing?.value;
  useEffect(() => {
    if (editingId) editInputRef.current?.select();
  }, [editingId]);

  const [renameWidth, setRenameWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = editInputRef.current;
    if (!editingId || editingValue === undefined || !el) {
      setRenameWidth(null);
      return;
    }
    const font = getComputedStyle(el).font;
    const textWidth = measureTextWidth(editingValue || ' ', font);
    // padding (4px * 2) + border (1px * 2) + a little caret room.
    setRenameWidth(Math.max(40, textWidth + 16));
  }, [editingId, editingValue]);

  const finishRename = (save: boolean) => {
    if (!editing) return;
    const current = editing;
    setEditing(null);
    if (save) onRename?.(current.id, current.value.trim());
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The tab travels with its description so the render below pairs the two by
  // reference instead of by index.
  const described = useMemo(() => {
    const sitesById = new Map(sites.map((site) => [site.id, site]));
    return tabs.map((tab) => ({ tab, ...describeTab(tab, t, sitesById, lastActivePaneId) }));
  }, [tabs, sites, t, lastActivePaneId]);
  const labelsKey = described.map((d) => d.label).join(' ');

  const [needsShrink, setNeedsShrink] = useState(false);
  useLayoutEffect(() => {
    const n = tabs.length;
    if (n === 0 || containerWidth === 0) {
      setNeedsShrink(false);
      return;
    }
    const capPx = labelRefs.current[0]
      ? parseFloat(getComputedStyle(labelRefs.current[0]).maxWidth) || Infinity
      : Infinity;
    const naturalTotal =
      described.reduce((sum, d, i) => {
        const el = labelRefs.current[i];
        const labelWidth = el ? Math.min(el.scrollWidth, capPx) : 0;
        return (
          sum +
          ITEM_PADDING +
          (d.status ? DOT_SPACE : 0) +
          labelWidth +
          (n > 1 ? CLOSE_BUTTON_SPACE : 0)
        );
      }, 0) +
      TAB_GAP * (n - 1);
    const available = containerWidth - ADD_BUTTON_SPACE - SCROLL_PADDING;
    setNeedsShrink(naturalTotal > available);
    // labelsKey captures every description change without depending on the unstable array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerWidth, labelsKey, tabs.length]);

  const { tabWidth, compact, lockstepOverflow } = useMemo(() => {
    if (!needsShrink) {
      return { tabWidth: undefined, compact: false, lockstepOverflow: false };
    }
    const n = tabs.length;
    if (containerWidth === 0) {
      return { tabWidth: MAX_TAB_WIDTH, compact: false, lockstepOverflow: false };
    }
    const available = containerWidth - ADD_BUTTON_SPACE - SCROLL_PADDING - TAB_GAP * (n - 1);
    const perTab = available / n;
    if (perTab >= MIN_TAB_WIDTH) {
      return { tabWidth: Math.min(perTab, MAX_TAB_WIDTH), compact: false, lockstepOverflow: false };
    }
    if (perTab >= MIN_TAB_WIDTH_COMPACT) {
      return { tabWidth: perTab, compact: true, lockstepOverflow: false };
    }
    return { tabWidth: MIN_TAB_WIDTH_COMPACT, compact: true, lockstepOverflow: true };
  }, [needsShrink, containerWidth, tabs.length]);

  const overflow = lockstepOverflow;

  const [truncated, setTruncated] = useState<boolean[]>([]);
  useLayoutEffect(() => {
    setTruncated(labelRefs.current.map((el) => !!el && el.scrollWidth > el.clientWidth + 1));
  }, [tabWidth, compact, containerWidth, labelsKey, tabs.length]);

  useEffect(() => {
    const index = tabs.findIndex((t) => t.id === activeTabId);
    tabRefs.current[index]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // `tabs` is read but deliberately not a dependency: only switching tabs or
    // opening/closing one can push the active tab out of view. Depending on the
    // array would re-scroll on every unrelated tab mutation — a path change, a
    // connection status change — yanking the strip while the user reads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, tabs.length]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (e.deltaY === 0) return;
      e.preventDefault();
      el.scrollLeft += document.documentElement.dir === 'rtl' ? -e.deltaY : e.deltaY;
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  const handleMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (
      e.button !== 0 ||
      !scrollRef.current ||
      (e.target instanceof Element && e.target.closest('.tab-strip-item'))
    )
      return;
    panStartXRef.current = e.clientX;
    panStartScrollLeftRef.current = scrollRef.current.scrollLeft;
    draggedRef.current = false;
    setPanning(true);
  };

  useEffect(() => {
    if (!panning) return;
    document.body.style.userSelect = 'none';
    const onMove = (e: MouseEvent) => {
      const el = scrollRef.current;
      if (!el) return;
      const dx = e.clientX - panStartXRef.current;
      if (!draggedRef.current && Math.abs(dx) < PAN_CLICK_THRESHOLD) return;
      draggedRef.current = true;
      el.scrollLeft = panStartScrollLeftRef.current - dx;
    };
    const onUp = () => setPanning(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [panning]);

  const handleTabKeyDown = (index: number) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const rtl = document.documentElement.dir === 'rtl';
      const next =
        (e.key === 'ArrowRight') !== rtl
          ? (index + 1) % tabs.length
          : (index - 1 + tabs.length) % tabs.length;
      const nextTab = tabs[next];
      if (!nextTab) return;
      onSelect(nextTab.id);
      tabRefs.current[next]?.focus();
    } else if (e.key === 'Delete' && tabs.length > 1) {
      const tab = tabs[index];
      if (!tab) return;
      e.preventDefault();
      onClose(tab.id);
    }
  };

  return (
    <div className={`tab-strip ${disabled ? 'disabled' : ''}`} ref={containerRef}>
      <div
        className={`tab-strip-scroll ${panning ? 'panning' : ''} ${overflow ? 'overflow' : ''}`}
        role="tablist"
        ref={scrollRef}
        onMouseDown={handleMouseDown}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictTabDrag]}
          onDragEnd={({ active, over }) => {
            if (over && active.id !== over.id) onReorder?.(String(active.id), String(over.id));
          }}
        >
          <SortableContext
            items={tabs.map((tab) => tab.id)}
            strategy={horizontalListSortingStrategy}
          >
            {described.map(({ tab, label, status, icon, color: savedColor }, index) => {
              const color = colored ? savedColor : '';
              const active = tab.id === activeTabId;
              return (
                <SortableTab
                  id={tab.id}
                  disabled={disabled || editing?.id === tab.id}
                  key={tab.id}
                  tabRef={(el) => {
                    tabRefs.current[index] = el;
                  }}
                  role="tab"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  className={`tab-strip-item ${active ? 'active' : ''} ${compact ? 'compact' : ''} ${savedColor && !colored ? 'muted-identity' : ''}`}
                  style={{ width: tabWidth }}
                  data-tooltip={label}
                  onClick={() => {
                    if (draggedRef.current) return;
                    onSelect(tab.id);
                  }}
                  onKeyDown={handleTabKeyDown(index)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!disabled) setEditing({ id: tab.id, value: tab.name || label });
                  }}
                  // Middle-click closes, same convention as every browser's own
                  // tab strip — cheap to support once the click handler exists.
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      onClose(tab.id);
                    }
                  }}
                >
                  {/* Clips dot+label independently of the item itself — the item
                  can't have overflow:hidden, since .active::after (the
                  bottom-fusion border) and the inter-tab divider both
                  deliberately poke a px or two outside its box. Without
                  this wrapper, a label that ends up wider than its
                  flex-shrunk allowance (rounding, font metrics) paints past
                  the tab's own rounded background instead of being clipped
                  to it. */}
                  <span className="tab-strip-content">
                    {status && <span className={`tab-strip-dot ${status}`} />}
                    {icon && <Icon name={icon as IconName} size={13} color={color || undefined} />}
                    {editing?.id === tab.id ? (
                      <input
                        ref={editInputRef}
                        className="tab-strip-rename-input"
                        value={editing.value}
                        style={renameWidth ? { width: `${renameWidth}px` } : undefined}
                        aria-label={t('tabStrip.rename')}
                        maxLength={80}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) =>
                          setEditing((current) =>
                            current ? { ...current, value: event.target.value } : current,
                          )
                        }
                        onBlur={() => finishRename(true)}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            finishRename(true);
                          } else if (event.key === 'Escape') {
                            event.preventDefault();
                            finishRename(false);
                          }
                        }}
                      />
                    ) : (
                      <span
                        ref={(el) => {
                          labelRefs.current[index] = el;
                        }}
                        className={`tab-strip-label ${status === 'idle' ? 'idle' : ''} ${truncated[index] ? 'truncated' : ''}`}
                        style={color ? { color } : undefined}
                      >
                        {label}
                      </span>
                    )}
                  </span>
                  {/* Below MIN_TAB_WIDTH (compact), only the active tab keeps a
                  close button — at those widths a hover-reveal × on every
                  tab is more likely to be mis-clicked than used, and
                  dropping it off the inactive ones is what buys back the
                  room to keep shrinking toward MIN_TAB_WIDTH_COMPACT. */}
                  {tabs.length > 1 && (!compact || active) && (
                    <span
                      className={`tab-strip-close ${compact ? 'floating' : ''}`}
                      data-tooltip={t('menu.file.closeTab')}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (draggedRef.current) return;
                        onClose(tab.id);
                      }}
                    >
                      <span className="tab-strip-close-glyph">×</span>
                    </span>
                  )}
                </SortableTab>
              );
            })}
          </SortableContext>
        </DndContext>
      </div>
      <button
        type="button"
        className="tab-strip-add"
        onClick={onNew}
        data-tooltip={t('tabStrip.newTabTooltip')}
      >
        +
      </button>
    </div>
  );
}
