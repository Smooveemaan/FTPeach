import type { CSSProperties, ReactElement, ReactNode, Ref, RefObject } from 'react';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { DIVIDER_WIDTH, ITEM_WIDTH } from '../../../hooks/useOverflowFold.ts';
import { useDateFormatter } from '../../settings/index.ts';
import type { PaneId } from '../panes/paneModel.ts';
import type { Translate } from './fileListModel.ts';
import SearchFilter from './SearchFilter.tsx';

interface PaneSourceMinWidthOptions {
  disconnected: boolean;
  style?: CSSProperties | undefined;
  onWidthChange?: ((width: number | undefined) => void) | undefined;
}

interface PaneSearchState {
  open: boolean;
  text: string;
  inputRef: RefObject<HTMLInputElement>;
  setOpen: (open: boolean) => void;
  close: () => void;
  setText: (text: string) => void;
}

interface PaneTitleBarProps {
  title: ReactNode;
  titleSlot?: ReactElement<{ ref?: Ref<HTMLElement> }> | null | undefined;
  updatedAt?: string | number | Date | null | undefined;
  disconnected: boolean;
  side: PaneId;
  search: PaneSearchState;
  toolbar?: ReactNode | undefined;
  sourceRef?: Ref<HTMLElement> | undefined;
  t: Translate;
}

export interface PaneSourceMinWidthModel {
  sourceRef: React.RefObject<HTMLElement>;
  paneStyle: React.CSSProperties | undefined;
}

export function usePaneSourceMinWidth({
  disconnected,
  style,
  onWidthChange,
}: PaneSourceMinWidthOptions): PaneSourceMinWidthModel {
  const sourceRef = useRef<HTMLElement>(null);
  const [sourceWidth, setSourceWidth] = useState(0);
  useLayoutEffect(() => {
    const element = sourceRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSourceWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const minWidth =
    !disconnected && sourceWidth > 0
      ? 24 + sourceWidth + ITEM_WIDTH + DIVIDER_WIDTH + ITEM_WIDTH + 12
      : undefined;
  useLayoutEffect(() => onWidthChange?.(minWidth), [minWidth, onWidthChange]);
  return { sourceRef, paneStyle: minWidth ? { ...style, minWidth } : style };
}

export default function PaneTitleBar({
  title,
  titleSlot,
  updatedAt,
  disconnected,
  side,
  search,
  toolbar,
  sourceRef,
  t,
}: PaneTitleBarProps) {
  const formatDate = useDateFormatter();
  const measuredTitleSlot =
    titleSlot && React.isValidElement(titleSlot)
      ? React.cloneElement(titleSlot, sourceRef ? { ref: sourceRef } : {})
      : titleSlot;
  return (
    <div
      className={`pane-titlebar ${search.open ? 'search-open' : ''} ${disconnected ? 'form-open' : ''}`}
    >
      {measuredTitleSlot || (
        <span
          className="pane-title"
          data-tooltip={
            updatedAt ? t('filePane.updatedAtTooltip', { date: formatDate(updatedAt) }) : undefined
          }
        >
          {title}
        </span>
      )}
      <SearchFilter
        side={side}
        open={search.open}
        value={search.text}
        inputRef={search.inputRef}
        onOpen={() => search.setOpen(true)}
        onClose={search.close}
        onChange={search.setText}
        t={t}
      />
      {toolbar}
    </div>
  );
}
