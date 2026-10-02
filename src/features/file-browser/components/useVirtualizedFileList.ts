import type React from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { ListImperativeAPI } from 'react-window';

export type VirtualListHandle = ListImperativeAPI;

export interface VirtualizedFileListModel {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  rowProbeRef: React.RefObject<HTMLDivElement | null>;
  listRef: React.RefObject<VirtualListHandle | null>;
  viewportSize: { width: number; height: number };
  rowHeight: number;
}

export default function useVirtualizedFileList(isVirtualized: boolean): VirtualizedFileListModel {
  const viewportRef = useRef<HTMLDivElement>(null);
  const rowProbeRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<VirtualListHandle>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [rowHeight, setRowHeight] = useState(28);

  useLayoutEffect(() => {
    const probe = rowProbeRef.current;
    if (!probe) return;
    const measure = () => {
      const dpr = window.devicePixelRatio || 1;
      const h = Math.round(probe.getBoundingClientRect().height * dpr) / dpr;
      if (h > 0) setRowHeight((prev) => (Math.abs(prev - h) > 0.5 ? h : prev));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(probe);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setViewportSize((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isVirtualized]);

  return { viewportRef, rowProbeRef, listRef, viewportSize, rowHeight };
}
