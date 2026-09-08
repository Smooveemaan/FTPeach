import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import React, { useLayoutEffect, useRef, useState } from 'react';

export interface VirtualListHandle {
  scrollToItem: (index: number, align?: 'auto' | 'smart' | 'center' | 'start' | 'end') => void;
}
interface PaneListExtra {
  side?: string;
  filesAriaLabel?: string;
  onPointerDown?: HTMLAttributes<HTMLDivElement>['onPointerDown'];
  onDragOver?: HTMLAttributes<HTMLDivElement>['onDragOver'];
  onDragLeave?: HTMLAttributes<HTMLDivElement>['onDragLeave'];
  onDrop?: HTMLAttributes<HTMLDivElement>['onDrop'];
  onContextMenu?: HTMLAttributes<HTMLDivElement>['onContextMenu'];
}
interface PaneListOuterProps {
  className?: string;
  style?: CSSProperties;
  onScroll?: HTMLAttributes<HTMLDivElement>['onScroll'];
  children?: ReactNode;
}

export interface VirtualizedFileListModel {
  viewportRef: React.RefObject<HTMLDivElement>;
  rowProbeRef: React.RefObject<HTMLDivElement>;
  listRef: React.RefObject<VirtualListHandle>;
  viewportSize: { width: number; height: number };
  rowHeight: number;
  outerElementType: React.ForwardRefExoticComponent<
    PaneListOuterProps & React.RefAttributes<HTMLDivElement>
  >;
  extraRef: React.MutableRefObject<PaneListExtra>;
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

  const paneListExtraRef = useRef<PaneListExtra>({});
  const [PaneListOuter] = useState(() =>
    React.forwardRef<HTMLDivElement, PaneListOuterProps>(function PaneListOuter(
      { className, style, onScroll, children },
      ref,
    ) {
      const extra = paneListExtraRef.current;
      return React.createElement(
        'div',
        {
          ref,
          className,
          style,
          onScroll,
          'data-side': extra.side,
          role: 'listbox',
          'aria-multiselectable': 'true',
          'aria-label': extra.filesAriaLabel,
          onPointerDown: extra.onPointerDown,
          onDragOver: extra.onDragOver,
          onDragLeave: extra.onDragLeave,
          onDrop: extra.onDrop,
          onContextMenu: extra.onContextMenu,
        },
        children,
      );
    }),
  );

  return {
    viewportRef,
    rowProbeRef,
    listRef,
    viewportSize,
    rowHeight,
    outerElementType: PaneListOuter,
    extraRef: paneListExtraRef,
  };
}
