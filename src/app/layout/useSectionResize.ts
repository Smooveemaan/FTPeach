import type { MutableRefObject, MouseEvent as ReactMouseEvent } from 'react';
import { useEffect, useReducer, useRef, useState } from 'react';
import type { AppSettings } from '../../platform/api/settings.ts';
import { getInterfaceScale } from '../../platform/interfaceScale.ts';
import { persistSetting } from '../../platform/persistSetting.ts';
import SETTINGS_DEFAULTS from '../../shared/settingsDefaults.ts';
import {
  TRANSFER_HEADER_HEIGHT,
  LOG_HEADER_HEIGHT,
  TRANSFER_HEADER_HEIGHT_NARROW,
  LOG_HEADER_HEIGHT_NARROW,
} from '../../shared/layoutMetrics.ts';
import type { ResizableSection } from './sectionResizeReducer.ts';
import { initialSectionResizeState, sectionResizeReducer } from './sectionResizeReducer.ts';
import { useDragSession } from '../../hooks/resize/useDragSession.ts';
import { useTransferLogSplit } from './useTransferLogSplit.ts';

interface SectionResizeOptions {
  showTransferQueue: boolean;
  logEnabled: boolean;
  paneOrientation: string;
  windowNarrow: boolean;
}

const PANE_MIN_HEIGHT = 68;
const PANE_DIVIDER_HEIGHT = 6;
const SECTION_RESIZER_HEIGHT = 6;
const PANE_RESIZER_WIDTH = 6;
const PANE_MIN_WIDTH_FALLBACK = 120;

const PANE_MIN_HEIGHT_HORIZONTAL = 200;

const NARROW_TRANSFER_QUEUE_MAX = 96;
const NARROW_LOG_PANEL_MAX = 84;

export interface SectionResizeModel {
  hydrateFromSettings: (s: AppSettings) => void;
  transferLogRef: MutableRefObject<HTMLDivElement | null>;
  transferLogSplitRatio: number;
  resizingTransferLog: boolean;
  startTransferLogResize: (event: ReactMouseEvent) => void;
  resetTransferLogSplitRatio: () => void;
  hydrateTransferLogSplit: (settings: AppSettings) => void;
  panesRef: MutableRefObject<HTMLDivElement | null>;
  splitRatio: number;
  resizing: boolean;
  startResize: (e: ReactMouseEvent) => void;
  resetSplitRatio: () => void;
  transferQueueHeight: number;
  logPanelHeight: number;
  transferManuallyResized: boolean;
  logManuallyResized: boolean;
  resizingSection: ResizableSection | null;
  startSectionResize: (section: ResizableSection) => (e: ReactMouseEvent) => void;
  resetSectionHeight: (section: ResizableSection) => () => void;
}

export function useSectionResize({
  showTransferQueue,
  logEnabled,
  paneOrientation,
  windowNarrow,
}: SectionResizeOptions): SectionResizeModel {
  const transferLogSplit = useTransferLogSplit();
  // Pane split
  const [splitRatio, setSplitRatio] = useState(SETTINGS_DEFAULTS.splitRatio);
  const panesRef = useRef<HTMLDivElement | null>(null);
  const [resizing, setResizing] = useState(false);
  const latestSplitRatio = useRef(SETTINGS_DEFAULTS.splitRatio);
  const dragTransferHeightRef = useRef(0);
  const dragLogHeightRef = useRef(0);

  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    dragTransferHeightRef.current = transferQueueHeight;
    dragLogHeightRef.current = logPanelHeight;
    setResizing(true);
  };

  const resetSplitRatio = () => {
    latestSplitRatio.current = 0.5;
    setSplitRatio(0.5);
    persistSetting({ splitRatio: 0.5 });
  };

  useDragSession({
    active: resizing,
    cursor: paneOrientation === 'vertical' ? 'row-resize' : 'col-resize',
    createHandlers: () => {
      const vertical = paneOrientation === 'vertical';
      return {
        onMove: ({ clientX, clientY, scale }) => {
          if (!panesRef.current) return;
          const domRect = panesRef.current.getBoundingClientRect();
          const rect = {
            top: domRect.top / scale,
            left: domRect.left / scale,
            width: domRect.width / scale,
            height: domRect.height / scale,
          };
          let ratio: number;
          if (vertical) {
            const metrics = getLayoutMetrics();
            const totalPanesHeight = Math.round(rect.height);
            // Desired local (top) pane height, straight from the cursor.
            let localHeight = Math.max(
              PANE_MIN_HEIGHT,
              Math.round(clientY - (metrics?.panesTop ?? rect.top)),
            );
            let remoteHeight = totalPanesHeight - PANE_DIVIDER_HEIGHT - localHeight;
            if (remoteHeight < PANE_MIN_HEIGHT && metrics) {
              remoteHeight = PANE_MIN_HEIGHT;
              let deficit = localHeight + PANE_DIVIDER_HEIGHT + remoteHeight - totalPanesHeight;
              if (windowNarrow && showTransferQueue && logEnabled) {
                const sharedFloor = Math.max(
                  TRANSFER_HEADER_HEIGHT_NARROW,
                  LOG_HEADER_HEIGHT_NARROW,
                );
                const currentRow = Math.max(
                  dragTransferHeightRef.current,
                  dragLogHeightRef.current,
                );
                const take = Math.min(deficit, Math.max(0, currentRow - sharedFloor));
                if (take > 0) {
                  const nextRow = currentRow - take;
                  dragTransferHeightRef.current = nextRow;
                  dragLogHeightRef.current = nextRow;
                  setTransferQueueHeight(nextRow);
                  setLogPanelHeight(nextRow);
                  deficit -= take;
                }
              } else {
                const transferFloor = windowNarrow
                  ? TRANSFER_HEADER_HEIGHT_NARROW
                  : TRANSFER_HEADER_HEIGHT;
                const logFloor = windowNarrow ? LOG_HEADER_HEIGHT_NARROW : LOG_HEADER_HEIGHT;
                if (deficit > 0 && showTransferQueue) {
                  const take = Math.min(
                    deficit,
                    Math.max(0, dragTransferHeightRef.current - transferFloor),
                  );
                  if (take > 0) {
                    dragTransferHeightRef.current -= take;
                    setTransferQueueHeight(dragTransferHeightRef.current);
                    deficit -= take;
                  }
                }
                if (deficit > 0 && logEnabled) {
                  const take = Math.min(deficit, Math.max(0, dragLogHeightRef.current - logFloor));
                  if (take > 0) {
                    dragLogHeightRef.current -= take;
                    setLogPanelHeight(dragLogHeightRef.current);
                    deficit -= take;
                  }
                }
              }
              if (deficit > 0) {
                localHeight = Math.max(PANE_MIN_HEIGHT, localHeight - deficit);
              }
            }
            ratio =
              localHeight + remoteHeight > 0 ? localHeight / (localHeight + remoteHeight) : 0.5;
          } else {
            if (rect.width > 0) {
              const physicalRatio = (clientX - rect.left) / rect.width;
              const rawRatio =
                getComputedStyle(panesRef.current).direction === 'rtl'
                  ? 1 - physicalRatio
                  : physicalRatio;
              const paneEls = Array.from(panesRef.current.children).filter(
                (el): el is HTMLElement =>
                  el instanceof HTMLElement && el.classList.contains('pane'),
              );
              const minA = parseFloat(paneEls[0]?.style.minWidth ?? '') || PANE_MIN_WIDTH_FALLBACK;
              const minB = parseFloat(paneEls[1]?.style.minWidth ?? '') || PANE_MIN_WIDTH_FALLBACK;
              const usableWidth = Math.max(0, rect.width - PANE_RESIZER_WIDTH);
              const minRatio = usableWidth > 0 ? minA / usableWidth : 0.2;
              const maxRatio = usableWidth > 0 ? 1 - minB / usableWidth : 0.8;
              ratio = Math.min(maxRatio, Math.max(minRatio, rawRatio));
            } else {
              ratio = latestSplitRatio.current;
            }
          }
          latestSplitRatio.current = ratio;
          setSplitRatio(ratio);
        },
        onEnd: () => {
          setResizing(false);
          persistSetting({ splitRatio: latestSplitRatio.current });
          if (paneOrientation === 'vertical') {
            persistSetting({
              transferQueueHeight: dragTransferHeightRef.current,
              logPanelHeight: dragLogHeightRef.current,
            });
          }
        },
      };
    },
    dependencies: [paneOrientation, showTransferQueue, logEnabled, windowNarrow],
  });

  // Responsive section heights
  const [transferQueueHeight, setTransferQueueHeight] = useState(
    SETTINGS_DEFAULTS.transferQueueHeight,
  );
  const [logPanelHeight, setLogPanelHeight] = useState(SETTINGS_DEFAULTS.logPanelHeight);
  const wasNarrowRef = useRef(false);
  const preNarrowTransferHeightRef = useRef<number | null>(null);
  const preNarrowLogHeightRef = useRef<number | null>(null);
  const narrowRowManuallyResizedRef = useRef(false);
  const preWideTransferHeightRef = useRef<number | null>(null);
  const preWideLogHeightRef = useRef<number | null>(null);
  const wideManuallyResizedRef = useRef(false);
  const windowNarrowRef = useRef(windowNarrow);
  windowNarrowRef.current = windowNarrow;
  useEffect(() => {
    if (windowNarrow && !wasNarrowRef.current) {
      preNarrowTransferHeightRef.current = transferQueueHeight;
      preNarrowLogHeightRef.current = logPanelHeight;
      narrowRowManuallyResizedRef.current = false;
      let nextTransfer: number;
      let nextLog: number;
      if (
        !wideManuallyResizedRef.current &&
        preWideTransferHeightRef.current != null &&
        preWideLogHeightRef.current != null
      ) {
        nextTransfer = preWideTransferHeightRef.current;
        nextLog = preWideLogHeightRef.current;
      } else {
        nextTransfer =
          transferQueueHeight <= TRANSFER_HEADER_HEIGHT
            ? TRANSFER_HEADER_HEIGHT_NARROW
            : Math.min(transferQueueHeight, NARROW_TRANSFER_QUEUE_MAX);
        nextLog =
          logPanelHeight <= LOG_HEADER_HEIGHT
            ? LOG_HEADER_HEIGHT_NARROW
            : Math.min(logPanelHeight, NARROW_LOG_PANEL_MAX);
      }
      if (showTransferQueue && logEnabled) {
        nextTransfer = nextLog = Math.max(nextTransfer, nextLog);
      }
      setTransferQueueHeight(nextTransfer);
      setLogPanelHeight(nextLog);
    } else if (!windowNarrow && wasNarrowRef.current) {
      preWideTransferHeightRef.current = transferQueueHeight;
      preWideLogHeightRef.current = logPanelHeight;
      wideManuallyResizedRef.current = false;
      if (!narrowRowManuallyResizedRef.current) {
        if (preNarrowTransferHeightRef.current != null) {
          setTransferQueueHeight(preNarrowTransferHeightRef.current);
        }
        if (preNarrowLogHeightRef.current != null) {
          setLogPanelHeight(preNarrowLogHeightRef.current);
        }
      } else {
        setTransferQueueHeight((h) => Math.max(h, TRANSFER_HEADER_HEIGHT));
        setLogPanelHeight((h) => Math.max(h, LOG_HEADER_HEIGHT));
      }
    }
    wasNarrowRef.current = windowNarrow;
    // transferQueueHeight/logPanelHeight are read only inside the narrow-entry
    // branch above (to snapshot the pre-narrow value at the exact moment it's
    // about to be clamped) — depending on them here would re-run this effect,
    // and re-snapshot, on every drag while already narrow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowNarrow]);
  const [sectionResizeState, dispatchSectionResize] = useReducer(
    sectionResizeReducer,
    initialSectionResizeState,
  );
  const {
    transferManuallyResized,
    logManuallyResized,
    activeSection: resizingSection,
  } = sectionResizeState;
  // Section resizing
  const latestSectionHeight = useRef(0);
  const dragStartPoolRef = useRef(0);
  const tradesWithTransfers = useRef(false); // true while dragging 'log' with the transfer queue visible
  // The transfer drag is measured against the log height at drag start.
  const dragStartLogHeightRef = useRef(0);
  const latestCascadedLogHeight = useRef(0);
  const latestCascadedTransferHeight = useRef(0);
  const pinnedLocalHeightRef = useRef(0);
  const dragStartPanesHeightRef = useRef(0);
  const dragStartSplitRatioRef = useRef(SETTINGS_DEFAULTS.splitRatio);

  const startSectionResize = (section: ResizableSection) => (e: ReactMouseEvent) => {
    e.preventDefault();
    latestSectionHeight.current = section === 'transfers' ? transferQueueHeight : logPanelHeight;
    tradesWithTransfers.current = section === 'log' && showTransferQueue;
    if (tradesWithTransfers.current) {
      dragStartPoolRef.current = transferQueueHeight + logPanelHeight;
      latestCascadedTransferHeight.current = transferQueueHeight;
    }
    if (section === 'transfers') {
      dragStartLogHeightRef.current = logPanelHeight;
      latestCascadedLogHeight.current = logPanelHeight;
    }
    if (paneOrientation === 'vertical' && panesRef.current) {
      const rect = panesRef.current.getBoundingClientRect();
      dragStartPanesHeightRef.current = Math.round(rect.height / getInterfaceScale());
      dragStartSplitRatioRef.current = latestSplitRatio.current;
      pinnedLocalHeightRef.current = Math.round(
        Math.max(0, dragStartPanesHeightRef.current - PANE_DIVIDER_HEIGHT) *
          latestSplitRatio.current,
      );
    }
    dispatchSectionResize({ type: 'start', section });
  };

  const applyPanesHeight = (panesHeight: number) => {
    if (paneOrientation !== 'vertical') return;
    if (panesHeight >= dragStartPanesHeightRef.current) {
      latestSplitRatio.current = dragStartSplitRatioRef.current;
      setSplitRatio(dragStartSplitRatioRef.current);
      return;
    }
    const availableForPanes = Math.max(0, panesHeight - PANE_DIVIDER_HEIGHT);
    const remoteHeightIfLocalPinned = availableForPanes - pinnedLocalHeightRef.current;
    const remoteHeight =
      remoteHeightIfLocalPinned >= PANE_MIN_HEIGHT ? remoteHeightIfLocalPinned : PANE_MIN_HEIGHT;
    const localHeight = availableForPanes - remoteHeight;
    const ratio = availableForPanes > 0 ? localHeight / availableForPanes : 0.5;
    latestSplitRatio.current = ratio;
    setSplitRatio(ratio);
  };

  const resetSectionHeight = (section: ResizableSection) => () => {
    const height =
      section === 'transfers'
        ? SETTINGS_DEFAULTS.transferQueueHeight
        : SETTINGS_DEFAULTS.logPanelHeight;
    const key = section === 'transfers' ? 'transferQueueHeight' : 'logPanelHeight';
    (section === 'transfers' ? setTransferQueueHeight : setLogPanelHeight)(height);
    dispatchSectionResize({ type: 'touch', section });
    if (windowNarrow) narrowRowManuallyResizedRef.current = true;
    else wideManuallyResizedRef.current = true;
    persistSetting({ [key]: height });
  };

  const getLayoutMetrics = () => {
    if (!panesRef.current) return null;
    const scale = getInterfaceScale();
    const panesTop = Math.round(panesRef.current.getBoundingClientRect().top / scale);
    const statusBarHeight = Math.round(
      (document.querySelector<HTMLElement>('.status-bar')?.getBoundingClientRect().height ??
        26 * scale) / scale,
    );
    const shellBottom = Math.round(
      (document.querySelector<HTMLElement>('.app-shell')?.getBoundingClientRect().bottom ??
        window.innerHeight) / scale,
    );
    return {
      panesTop,
      logBottom: shellBottom - statusBarHeight,
      totalAvailable: shellBottom - panesTop - statusBarHeight,
    };
  };

  useEffect(() => {
    const reconcileToWindow = () => {
      const metrics = getLayoutMetrics();
      if (!metrics) return;
      const minPanesHeightNow =
        paneOrientation === 'vertical'
          ? PANE_MIN_HEIGHT * 2 + PANE_DIVIDER_HEIGHT
          : PANE_MIN_HEIGHT_HORIZONTAL;

      if (windowNarrow && showTransferQueue && logEnabled) {
        const maxRow = Math.max(
          TRANSFER_HEADER_HEIGHT_NARROW,
          metrics.totalAvailable - SECTION_RESIZER_HEIGHT - minPanesHeightNow,
        );
        if (transferQueueHeight > maxRow) setTransferQueueHeight(maxRow);
        if (logPanelHeight > maxRow) setLogPanelHeight(maxRow);
        return;
      }
      if (showTransferQueue && logEnabled) {
        const pool = transferQueueHeight + logPanelHeight;
        const comfortMaxPool =
          metrics.totalAvailable - SECTION_RESIZER_HEIGHT * 2 - minPanesHeightNow;
        const panesFloorNow =
          pool > comfortMaxPool
            ? paneOrientation === 'vertical'
              ? minPanesHeightNow
              : PANE_MIN_HEIGHT
            : minPanesHeightNow;
        const maxPool = Math.max(
          TRANSFER_HEADER_HEIGHT + LOG_HEADER_HEIGHT,
          metrics.totalAvailable - SECTION_RESIZER_HEIGHT * 2 - panesFloorNow,
        );
        if (pool > maxPool) {
          // Shrink both proportionally so neither is singled out, each
          // floored at its own header-row minimum.
          const nextTransfer = Math.max(
            TRANSFER_HEADER_HEIGHT,
            Math.round((transferQueueHeight * maxPool) / pool),
          );
          const nextLog = Math.max(LOG_HEADER_HEIGHT, maxPool - nextTransfer);
          setTransferQueueHeight(nextTransfer);
          setLogPanelHeight(nextLog);
        }
        return;
      }
      const availableForSingle =
        metrics.totalAvailable - SECTION_RESIZER_HEIGHT - minPanesHeightNow;
      const maxTransfer = Math.max(
        windowNarrow ? TRANSFER_HEADER_HEIGHT_NARROW : TRANSFER_HEADER_HEIGHT,
        availableForSingle,
      );
      const maxLog = Math.max(
        windowNarrow ? LOG_HEADER_HEIGHT_NARROW : LOG_HEADER_HEIGHT,
        availableForSingle,
      );
      if (showTransferQueue && transferQueueHeight > maxTransfer)
        setTransferQueueHeight(maxTransfer);
      if (logEnabled && logPanelHeight > maxLog) setLogPanelHeight(maxLog);
    };
    reconcileToWindow();
    window.addEventListener('resize', reconcileToWindow);
    return () => window.removeEventListener('resize', reconcileToWindow);
  }, [
    paneOrientation,
    showTransferQueue,
    logEnabled,
    windowNarrow,
    transferQueueHeight,
    logPanelHeight,
  ]);

  useDragSession({
    active: resizingSection !== null,
    cursor: 'row-resize',
    createHandlers: () => {
      if (!resizingSection) {
        return { onMove: () => undefined, onEnd: () => undefined };
      }
      const minPanesHeight =
        paneOrientation === 'vertical'
          ? PANE_MIN_HEIGHT * 2 + PANE_DIVIDER_HEIGHT
          : PANE_MIN_HEIGHT_HORIZONTAL;
      return {
        onMove: ({ clientY }) => {
          dispatchSectionResize({ type: 'touch', section: resizingSection });
          if (!windowNarrow) wideManuallyResizedRef.current = true;
          const metrics = getLayoutMetrics() ?? {
            panesTop: 0,
            logBottom: 480,
            totalAvailable: 480,
          };
          if (resizingSection === 'log' && tradesWithTransfers.current) {
            const panesFloor =
              paneOrientation === 'vertical'
                ? PANE_MIN_HEIGHT * 2 + PANE_DIVIDER_HEIGHT
                : PANE_MIN_HEIGHT;
            const maxLog =
              metrics.totalAvailable -
              SECTION_RESIZER_HEIGHT * 2 -
              panesFloor -
              TRANSFER_HEADER_HEIGHT;
            let nextLog = Math.max(LOG_HEADER_HEIGHT, metrics.logBottom - clientY);
            nextLog = Math.min(nextLog, maxLog);
            const pool = Math.max(dragStartPoolRef.current, nextLog + TRANSFER_HEADER_HEIGHT);
            const nextTransfer = pool - nextLog;
            const panesHeight = metrics.totalAvailable - SECTION_RESIZER_HEIGHT * 2 - pool;
            latestSectionHeight.current = nextLog;
            latestCascadedTransferHeight.current = nextTransfer;
            setLogPanelHeight(nextLog);
            setTransferQueueHeight(nextTransfer);
            applyPanesHeight(panesHeight);
          } else if (
            resizingSection === 'transfers' &&
            logEnabled &&
            windowNarrow &&
            showTransferQueue
          ) {
            const panesHeight = Math.max(minPanesHeight, clientY - metrics.panesTop);
            const rowHeight = Math.max(
              TRANSFER_HEADER_HEIGHT_NARROW,
              metrics.totalAvailable - SECTION_RESIZER_HEIGHT - panesHeight,
            );
            latestSectionHeight.current = rowHeight;
            latestCascadedLogHeight.current = rowHeight;
            setTransferQueueHeight(rowHeight);
            setLogPanelHeight(rowHeight);
            applyPanesHeight(metrics.totalAvailable - SECTION_RESIZER_HEIGHT - rowHeight);
          } else if (resizingSection === 'transfers' && logEnabled) {
            const panesFloor =
              paneOrientation === 'vertical'
                ? PANE_MIN_HEIGHT * 2 + PANE_DIVIDER_HEIGHT
                : PANE_MIN_HEIGHT;
            const maxPanesHeightForSections =
              metrics.totalAvailable -
              SECTION_RESIZER_HEIGHT * 2 -
              TRANSFER_HEADER_HEIGHT -
              LOG_HEADER_HEIGHT;
            const panesHeight = Math.min(
              maxPanesHeightForSections,
              Math.max(panesFloor, clientY - metrics.panesTop),
            );
            const remainingForTransferAndLog =
              metrics.totalAvailable - SECTION_RESIZER_HEIGHT * 2 - panesHeight;
            const nextLog = Math.max(
              LOG_HEADER_HEIGHT,
              Math.min(
                dragStartLogHeightRef.current,
                remainingForTransferAndLog - TRANSFER_HEADER_HEIGHT,
              ),
            );
            const nextTransfer = Math.max(
              TRANSFER_HEADER_HEIGHT,
              remainingForTransferAndLog - nextLog,
            );
            latestSectionHeight.current = nextTransfer;
            latestCascadedLogHeight.current = nextLog;
            setTransferQueueHeight(nextTransfer);
            setLogPanelHeight(nextLog);
            applyPanesHeight(panesHeight);
          } else {
            const panesHeight = Math.max(minPanesHeight, clientY - metrics.panesTop);
            const sectionMin =
              resizingSection === 'transfers'
                ? windowNarrow
                  ? TRANSFER_HEADER_HEIGHT_NARROW
                  : TRANSFER_HEADER_HEIGHT
                : windowNarrow
                  ? LOG_HEADER_HEIGHT_NARROW
                  : LOG_HEADER_HEIGHT;
            const next = Math.max(
              sectionMin,
              metrics.totalAvailable - SECTION_RESIZER_HEIGHT - panesHeight,
            );
            latestSectionHeight.current = next;
            (resizingSection === 'transfers' ? setTransferQueueHeight : setLogPanelHeight)(next);
            applyPanesHeight(metrics.totalAvailable - SECTION_RESIZER_HEIGHT - next);
          }
        },
        onEnd: () => {
          dispatchSectionResize({ type: 'stop' });
          if (resizingSection === 'transfers' && windowNarrow && showTransferQueue && logEnabled) {
            narrowRowManuallyResizedRef.current = true;
          }
          if (resizingSection === 'log' && tradesWithTransfers.current) {
            persistSetting({
              logPanelHeight: latestSectionHeight.current,
              transferQueueHeight: latestCascadedTransferHeight.current,
            });
          } else if (resizingSection === 'transfers' && logEnabled) {
            persistSetting({
              transferQueueHeight: latestSectionHeight.current,
              logPanelHeight: latestCascadedLogHeight.current,
            });
          } else {
            const key = resizingSection === 'transfers' ? 'transferQueueHeight' : 'logPanelHeight';
            persistSetting({ [key]: latestSectionHeight.current });
          }
          if (paneOrientation === 'vertical') {
            persistSetting({ splitRatio: latestSplitRatio.current });
          }
        },
      };
    },
    // logEnabled/paneOrientation/windowNarrow/showTransferQueue are read
    // directly in onMove/onUp above — same stale-closure reasoning as the
    // pane-split effect further up. applyPanesHeight is omitted on purpose
    // too: it's a plain function (new reference every render) whose only
    // real dependency is paneOrientation, already listed here — adding it
    // would just make this effect re-subscribe its mousemove/mouseup
    // listeners on every unrelated render of this hook instead of only when
    // something that actually changes its behavior does.
    dependencies: [paneOrientation, logEnabled, windowNarrow, showTransferQueue],
  });

  // Persistence
  const hydrateFromSettings = (s: AppSettings) => {
    const savedRatio =
      typeof s.splitRatio === 'number' ? s.splitRatio : SETTINGS_DEFAULTS.splitRatio;
    latestSplitRatio.current = savedRatio;
    setSplitRatio(savedRatio);
    const savedTransferHeight =
      typeof s.transferQueueHeight === 'number'
        ? s.transferQueueHeight
        : SETTINGS_DEFAULTS.transferQueueHeight;
    const savedLogHeight =
      typeof s.logPanelHeight === 'number' ? s.logPanelHeight : SETTINGS_DEFAULTS.logPanelHeight;
    setTransferQueueHeight(
      windowNarrowRef.current
        ? Math.min(savedTransferHeight, NARROW_TRANSFER_QUEUE_MAX)
        : savedTransferHeight,
    );
    setLogPanelHeight(
      windowNarrowRef.current ? Math.min(savedLogHeight, NARROW_LOG_PANEL_MAX) : savedLogHeight,
    );
    transferLogSplit.hydrateTransferLogSplit(s);
  };

  return {
    panesRef,
    splitRatio,
    resizing,
    startResize,
    resetSplitRatio,
    transferQueueHeight,
    logPanelHeight,
    transferManuallyResized,
    logManuallyResized,
    resizingSection,
    startSectionResize,
    resetSectionHeight,
    ...transferLogSplit,
    hydrateFromSettings,
  };
}
