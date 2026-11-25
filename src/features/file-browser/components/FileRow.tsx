import { hostPlatform } from '../../../platform/os.ts';
import { memo } from 'react';
import Icon from '../../../components/Icon.tsx';
import { COLUMN_DEFS, fileIconName } from './fileListModel.ts';
import { isolate } from '../../../shared/bidi.ts';
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import type { FileEntry } from '../../../shared/paneContracts.ts';
import type { PaneId } from '../panes/paneModel.ts';
import type { ColumnKey, Translate } from './fileListModel.ts';
import { useTruncated } from '../../../hooks/useTruncated.ts';
import { useDateFormatter } from '../../settings/index.ts';

interface FileColumnCellProps {
  columnKey: ColumnKey;
  entry: FileEntry;
  fileListScale: number;
  t: Translate;
}

function FileColumnCell({ columnKey, entry, fileListScale, t }: FileColumnCellProps) {
  const formatDate = useDateFormatter();
  const content = COLUMN_DEFS[columnKey].render(entry, t, formatDate);
  const [ref, truncated] = useTruncated<HTMLSpanElement>([content, fileListScale]);
  return (
    <span
      ref={ref}
      data-column-cell={columnKey}
      className={`col-${columnKey}${truncated ? ' truncated' : ''}`}
    >
      <bdi>{content}</bdi>
    </span>
  );
}

interface FileRowProps {
  entry: FileEntry;
  index: number;
  side: PaneId;
  style?: CSSProperties | undefined;
  selected: boolean;
  cut: boolean;
  dragTarget: boolean;
  gridTemplateColumns: string;
  nameWidth: number;
  fileListScale?: number | undefined;
  iconSize?: number | undefined;
  iconTrackWidth?: number | undefined;
  activeColumns: readonly ColumnKey[];
  t: Translate;
  onRowMouseDown?: ((entry: FileEntry, event: ReactMouseEvent<HTMLDivElement>) => void) | undefined;
  onRowClick?: ((index: number, event: ReactMouseEvent<HTMLDivElement>) => void) | undefined;
  onRowContextMenu?: (
    event: ReactMouseEvent<HTMLDivElement>,
    entry: FileEntry,
    index: number,
  ) => void;
  rename?: ReactNode | undefined;
}

function FileRow({
  entry,
  index,
  side,
  style,
  selected,
  cut,
  dragTarget,
  gridTemplateColumns,
  nameWidth,
  fileListScale = 100,
  iconSize = 13,
  iconTrackWidth = 20,
  activeColumns,
  t,
  onRowMouseDown,
  onRowClick,
  onRowContextMenu,
  rename,
}: FileRowProps) {
  const rtl = document.documentElement.dir === 'rtl';
  const [nameRef, nameTruncated] = useTruncated<HTMLSpanElement>([
    rename,
    entry.name,
    fileListScale,
  ]);

  return (
    <div
      id={`file-row-${side}-${index}`}
      role="option"
      aria-selected={selected}
      aria-label={`${isolate(entry.name)}, ${t(entry.isDirectory ? 'filePane.fileTypeFolder' : 'filePane.fileTypeGeneric')}`}
      data-name={entry.name}
      data-index={index}
      onMouseDown={(e) => {
        if (hostPlatform() === 'macos' && e.ctrlKey && !e.metaKey && e.button === 0) return;
        onRowMouseDown?.(entry, e);
      }}
      className={`row ${entry.isDirectory ? 'is-dir' : ''} ${selected ? 'selected' : ''} ${entry.isHidden || entry.name.startsWith('.') ? 'is-hidden' : ''} ${dragTarget ? 'drag-target' : ''} ${cut ? 'is-cut' : ''}`}
      style={
        {
          ...style,
          /* react-window physically anchors every virtual row with left: 0.
             Header columns, however, are anchored to the inline start by
             their trailing filler track, so in RTL the two grids diverged.
             Pin fit-content rows to the same right edge as the header. */
          left: rtl ? 'auto' : style?.left,
          right: rtl ? 0 : style?.right,
          gridTemplateColumns,
          width: 'fit-content',
          '--name-cell-width': `${iconTrackWidth + 8 + nameWidth}px`,
        } as CSSProperties
      }
      onClick={(e) => {
        if (hostPlatform() === 'macos' && e.ctrlKey && !e.metaKey && e.button === 0) {
          onRowContextMenu?.(e, entry, index);
          return;
        }
        onRowClick?.(index, e);
      }}
      onContextMenu={(e) => onRowContextMenu?.(e, entry, index)}
    >
      <span className="icon">
        <Icon name={fileIconName(entry)} size={iconSize} />
      </span>
      <span
        ref={nameRef}
        className={`name${rename ? ' is-renaming' : nameTruncated ? ' truncated' : ''}`}
        dir={rename ? undefined : 'auto'}
      >
        {rename || <bdi>{entry.name}</bdi>}
      </span>
      {activeColumns.map((key) => (
        <FileColumnCell
          key={key}
          columnKey={key}
          entry={entry}
          fileListScale={fileListScale}
          t={t}
        />
      ))}
    </div>
  );
}

export default memo(FileRow);
