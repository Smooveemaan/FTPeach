import { List } from 'react-window';
import type { RowComponentProps } from 'react-window';
import type { CSSProperties, HTMLAttributes, ReactNode, RefObject } from 'react';
import type { FileEntry } from '../../../shared/paneContracts.ts';
import type { Translate } from './fileListModel.ts';
import type { VirtualListHandle } from './useVirtualizedFileList.ts';

type RenderRow = (entry: FileEntry, index: number, style?: CSSProperties) => ReactNode;

interface VirtualRowProps {
  entries: readonly FileEntry[];
  renderRow: RenderRow;
}

interface PaneListProps extends HTMLAttributes<HTMLDivElement> {
  'data-side'?: string;
}

interface FileListProps {
  virtualized: boolean;
  listRef: RefObject<VirtualListHandle | null>;
  viewportRef: RefObject<HTMLDivElement | null>;
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
  /** The rows' columns, which an empty list still spans so it scrolls sideways. */
  gridTemplateColumns?: string | undefined;
  t: Translate;
}

function VirtualRow({ index, style, entries, renderRow }: RowComponentProps<VirtualRowProps>) {
  const entry = entries[index];
  return entry ? <>{renderRow(entry, index, style)}</> : null;
}

/** Module-level: the list calls it during render and must get the same function each time. */
const rowKey = (index: number, { entries }: VirtualRowProps) => entries[index]?.name ?? index;

export default function FileList({
  virtualized,
  listRef,
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
  gridTemplateColumns,
  t,
}: FileListProps) {
  if (virtualized) {
    return (
      <div className="pane-list-viewport" ref={viewportRef}>
        <List<VirtualRowProps>
          {...listProps}
          listRef={listRef}
          className={className}
          style={{ height: viewportSize.height, width: viewportSize.width }}
          rowComponent={VirtualRow}
          rowCount={entries.length}
          rowHeight={rowHeight}
          rowProps={{ entries, renderRow }}
          rowKey={rowKey}
        />
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
      {entries.length === 0 && gridTemplateColumns && (
        // No rows to be as wide as the columns, so the header, which scrolls
        // in step with the list, would have nothing to scroll to.
        <div className="row pane-list-width" aria-hidden="true" style={{ gridTemplateColumns }} />
      )}
      {entries.length > 0 && entries.map((entry, index) => renderRow(entry, index))}
    </div>
  );
}
