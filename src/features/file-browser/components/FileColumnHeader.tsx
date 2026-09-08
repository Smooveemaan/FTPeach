import type { KeyboardEvent, MouseEvent, MutableRefObject, ReactNode } from 'react';
import Icon from '../../../components/Icon.tsx';
import type { Translate } from '../../../shared/types.ts';
import type { ColumnKey, SortKey } from './fileListModel.ts';
import { useTruncated } from '../../../hooks/useTruncated.ts';
import type { UseColumnDragReorderResult } from '../../../hooks/useColumnDragReorder.ts';

interface ColumnHeaderCellProps {
  columnKey: ColumnKey;
  label: ReactNode;
  /** Plain-text stand-in for `label` (which also carries the sort-indicator
   * icon) — a stable primitive dep for the truncation check instead of a
   * freshly-created JSX node every render. */
  labelText: string;
  reorderable: boolean;
  resizable: boolean;
  dragging: boolean;
  pressed: boolean;
  tooltip: string;
  registerRef: (key: string, element: HTMLElement | null) => void;
  onMouseDown: (event: MouseEvent<HTMLElement>) => void;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  startColumnResize: (key: SortKey) => (event: MouseEvent<HTMLElement>) => void;
  autoFitColumn: (key: SortKey) => (event: MouseEvent<HTMLElement>) => void;
}

function ColumnHeaderCell({
  columnKey,
  label,
  labelText,
  reorderable,
  resizable,
  dragging,
  pressed,
  tooltip,
  registerRef,
  onMouseDown,
  onClick,
  onKeyDown,
  startColumnResize,
  autoFitColumn,
}: ColumnHeaderCellProps) {
  const [truncatedRef, truncated] = useTruncated<HTMLSpanElement>([labelText, pressed]);
  return (
    <span
      ref={(element) => {
        registerRef(columnKey, element);
        truncatedRef.current = element;
      }}
      data-column-key={columnKey}
      data-reorderable={reorderable ? 'true' : undefined}
      data-dragging={dragging ? 'true' : undefined}
      className={`col-header sortable${truncated ? ' truncated' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={pressed}
      data-tooltip={tooltip}
      onMouseDown={onMouseDown}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <span className="col-header-label">{label}</span>
      {resizable && (
        <span
          className="col-resize-handle"
          onMouseDown={startColumnResize(columnKey)}
          onDoubleClick={autoFitColumn(columnKey)}
          onClick={(event) => event.stopPropagation()}
        />
      )}
    </span>
  );
}

interface FileColumnHeaderProps {
  activeColumns: readonly ColumnKey[];
  autoFitColumn: (key: SortKey) => (event: MouseEvent<HTMLElement>) => void;
  registerHeaderRef: UseColumnDragReorderResult['registerHeaderRef'];
  getDragHandleProps: UseColumnDragReorderResult['getDragHandleProps'];
  columnLabels: Record<ColumnKey, string>;
  draggedColumn: string | null;
  gridTemplateColumns: string;
  nameAscExplicit: boolean;
  nameHeaderRef: MutableRefObject<HTMLElement | null>;
  reorderable: boolean;
  resizable: boolean;
  sortDir: 'asc' | 'desc';
  sortKey: SortKey;
  startColumnResize: (key: SortKey) => (event: MouseEvent<HTMLElement>) => void;
  suppressColumnClickRef: MutableRefObject<boolean>;
  t: Translate;
  toggleSort: (key: SortKey) => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
}

export default function FileColumnHeader({
  activeColumns,
  autoFitColumn,
  registerHeaderRef,
  getDragHandleProps,
  columnLabels,
  draggedColumn,
  gridTemplateColumns,
  nameAscExplicit,
  nameHeaderRef,
  reorderable,
  resizable,
  sortDir,
  sortKey,
  startColumnResize,
  suppressColumnClickRef,
  t,
  toggleSort,
  onContextMenu,
}: FileColumnHeaderProps) {
  const handleKeyDown = (key: SortKey) => (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleSort(key);
    }
  };
  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return null;
    if (key === 'name' && sortDir === 'asc' && !nameAscExplicit) return null;
    return (
      <span className={`sort-indicator ${sortDir === 'desc' ? 'desc' : ''}`}>
        <Icon name="chevronUp" size={10} />
      </span>
    );
  };
  const handleSortClick = (key: SortKey) => {
    if (suppressColumnClickRef.current) {
      suppressColumnClickRef.current = false;
      return;
    }
    toggleSort(key);
  };

  const [nameTruncatedRef, nameTruncated] = useTruncated<HTMLSpanElement>([
    sortKey,
    sortDir,
    nameAscExplicit,
  ]);

  return (
    <div
      className="row row-header"
      style={{ gridTemplateColumns }}
      onContextMenu={onContextMenu}
      data-tooltip={t('filePane.chooseColumnsTooltip')}
      data-tooltip-vgroup
    >
      <span />
      <span
        ref={(element) => {
          nameHeaderRef.current = element;
          nameTruncatedRef.current = element;
        }}
        className={`col-header sortable${nameTruncated ? ' truncated' : ''}`}
        role="button"
        tabIndex={0}
        aria-pressed={sortKey === 'name'}
        data-tooltip={t('filePane.sortByNameTooltip')}
        onClick={() => handleSortClick('name')}
        onKeyDown={handleKeyDown('name')}
      >
        <span className="col-header-label">
          {t('filePane.columnName')}
          {sortIndicator('name')}
        </span>
        {resizable && (
          <span
            className="col-resize-handle"
            onMouseDown={startColumnResize('name')}
            onDoubleClick={autoFitColumn('name')}
            onClick={(event) => event.stopPropagation()}
          />
        )}
      </span>
      {activeColumns.map((key) => {
        const dragHandleProps = getDragHandleProps(key);
        const columnLabel = columnLabels[key];
        return (
          <ColumnHeaderCell
            key={key}
            columnKey={key}
            label={
              <>
                {columnLabel}
                {sortIndicator(key)}
              </>
            }
            labelText={columnLabel}
            reorderable={reorderable}
            resizable={resizable}
            dragging={draggedColumn === key}
            pressed={sortKey === key}
            tooltip={t('filePane.sortByColumnTooltip', { column: columnLabel })}
            registerRef={(k, element) => registerHeaderRef(k)(element)}
            onMouseDown={reorderable ? dragHandleProps.onMouseDown : () => {}}
            onClick={() => handleSortClick(key)}
            onKeyDown={handleKeyDown(key)}
            startColumnResize={startColumnResize}
            autoFitColumn={autoFitColumn}
          />
        );
      })}
    </div>
  );
}
