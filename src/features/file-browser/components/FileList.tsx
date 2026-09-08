import { FixedSizeList } from 'react-window';
import type { ListChildComponentProps, ReactElementType } from 'react-window';
import type { CSSProperties, HTMLAttributes, MutableRefObject, ReactNode, RefObject } from 'react';
import type { FileEntry } from '../../../shared/types.ts';
import type { Translate } from './fileListModel.ts';
import type { VirtualListHandle } from './useVirtualizedFileList.ts';

type RenderRow = (entry: FileEntry, index: number, style?: CSSProperties) => ReactNode;

interface VirtualRowData {
  entries: readonly FileEntry[];
  renderRow: RenderRow;
}

interface PaneListProps extends HTMLAttributes<HTMLDivElement> {
  'data-side'?: string;
}

interface FileListProps {
  virtualized: boolean;
  listRef: MutableRefObject<VirtualListHandle | null>;
  outerElementType: ReactElementType;
  viewportRef: RefObject<HTMLDivElement>;
  viewportSize: { width: number; height: number };
  rowHeight: number;
  entries: readonly FileEntry[];
  renderRow: RenderRow;
  className: string;
  listProps: PaneListProps;
  loading: boolean;
  disconnected: boolean;
  filterText: string;
  emptyMessage?: ReactNode;
  t: Translate;
}

function VirtualRow({ index, style, data }: ListChildComponentProps<VirtualRowData>) {
  const entry = data.entries[index];
  return entry ? data.renderRow(entry, index, style) : null;
}

export default function FileList({
  virtualized,
  listRef,
  outerElementType,
  viewportRef,
  viewportSize,
  rowHeight,
  entries,
  renderRow,
  className,
  listProps,
  loading,
  disconnected,
  filterText,
  emptyMessage,
  t,
}: FileListProps) {
  if (virtualized) {
    return (
      <div className="pane-list-viewport" ref={viewportRef}>
        <FixedSizeList<VirtualRowData>
          ref={(instance) => {
            listRef.current = instance;
          }}
          outerElementType={outerElementType}
          className={className}
          style={{ overflowX: 'hidden' }}
          height={viewportSize.height}
          width={viewportSize.width}
          itemCount={entries.length}
          itemSize={rowHeight}
          itemData={{ entries, renderRow }}
          itemKey={(index, data) => data.entries[index]?.name ?? index}
        >
          {VirtualRow}
        </FixedSizeList>
      </div>
    );
  }

  // Only blank the list for a loading placeholder when there's nothing to
  // show yet — once a folder has rows on screen, keep them mounted through a
  // refresh/navigation instead of rebuilding fresh ones. Swapping the DOM
  // out mid-navigation is what breaks the manual dblclick detection in
  // FilePane.tsx's handleRowClickWithDoubleDetect (see its own comment).
  const showLoadingPlaceholder = loading && !disconnected && entries.length === 0;
  const showEmptyMessage = !showLoadingPlaceholder && entries.length === 0;

  return (
    <div className={className} {...listProps}>
      {showLoadingPlaceholder && (
        <div className="pane-empty" role="status">
          {t('filePane.loading')}
        </div>
      )}
      {showEmptyMessage && (
        <div className="pane-empty" role="status">
          {filterText ? t('filePane.nothingFound') : emptyMessage || t('filePane.emptyFolder')}
        </div>
      )}
      {entries.length > 0 && entries.map((entry, index) => renderRow(entry, index))}
    </div>
  );
}
