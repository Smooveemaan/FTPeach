import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../components/Icon.tsx';
import type { IconName } from '../../../components/Icon.tsx';
import type { PaneKind } from '../panes/paneModel.ts';

export interface PathCrumb {
  path: string;
  label: ReactNode;
  icon?: IconName;
}

interface PathBarProps {
  kind: PaneKind;
  crumbs: readonly PathCrumb[];
  onCrumbClick: (path: string) => void;
  onDriveMenuOpen?: ((event: ReactMouseEvent<HTMLSpanElement>) => void) | undefined;
  onPathSubmit?: ((path: string) => void) | undefined;
}

export default function PathBar({
  kind,
  crumbs,
  onCrumbClick,
  onDriveMenuOpen,
  onPathSubmit,
}: PathBarProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [tailStart, setTailStart] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const fullPath = crumbs.at(-1)?.path ?? '';
  const pathKey = useMemo(() => crumbs.map((crumb) => crumb.path).join(' '), [crumbs]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure || editing) return undefined;
    const recompute = () => {
      const count = crumbs.length;
      if (count <= 1) {
        setTailStart(1);
        return;
      }
      const children = Array.from(measure.children);
      // The measuring row is rendered from the same crumbs, so every index
      // below exists; treating a missing one as zero keeps a mid-render
      // measurement from throwing instead of just folding one crumb early.
      const widthOf = (index: number) => children[index]?.getBoundingClientRect().width ?? 0;
      const at = (widths: readonly number[], index: number) => widths[index] ?? 0;
      const crumbWidths: number[] = [];
      const separatorWidths: number[] = [];
      let childIndex = 0;
      crumbWidths[0] = widthOf(childIndex++);
      for (let index = 1; index < count; index += 1) {
        separatorWidths[index] = widthOf(childIndex++);
        crumbWidths[index] = widthOf(childIndex++);
      }
      const ellipsisWidth = widthOf(childIndex);
      const styles = getComputedStyle(container);
      const gap = parseFloat(styles.columnGap || styles.gap) || 0;
      const available =
        container.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
      const unit = (index: number) => 2 * gap + at(separatorWidths, index) + at(crumbWidths, index);
      const suffixWidths: number[] = new Array<number>(count);
      suffixWidths[count - 1] = unit(count - 1);
      for (let index = count - 2; index >= 1; index -= 1) {
        suffixWidths[index] = at(suffixWidths, index + 1) + unit(index);
      }
      if (at(crumbWidths, 0) + at(suffixWidths, 1) <= available) {
        setTailStart(1);
        return;
      }
      const ellipsisUnit = 2 * gap + at(separatorWidths, 1) + ellipsisWidth;
      let nextTailStart = count - 1;
      for (let index = 2; index < count; index += 1) {
        if (at(crumbWidths, 0) + ellipsisUnit + at(suffixWidths, index) <= available) {
          nextTailStart = index;
          break;
        }
      }
      setTailStart(nextTailStart);
    };
    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(container);
    return () => observer.disconnect();
  }, [crumbs, editing, pathKey]);

  const startEditing = () => {
    if (!onPathSubmit) return;
    setValue(fullPath);
    setEditing(true);
  };
  const commit = () => {
    const nextValue = value.trim();
    setEditing(false);
    if (nextValue) onPathSubmit?.(nextValue);
  };
  const renderCrumb = (crumb: PathCrumb, index: number, measured = false) => {
    const isDriveCrumb = index === 0 && kind === 'local' && Boolean(onDriveMenuOpen);
    return (
      <React.Fragment key={crumb.path}>
        {index > 0 && <span className="sep">/</span>}
        <span
          className={isDriveCrumb ? 'crumb crumb-drive' : 'crumb'}
          data-tooltip={!measured && crumb.icon ? crumb.label : undefined}
          onClick={
            measured
              ? undefined
              : (event) => {
                  event.stopPropagation();
                  onCrumbClick(crumb.path);
                }
          }
        >
          {crumb.icon ? <Icon name={crumb.icon} size={13} /> : <bdi>{crumb.label}</bdi>}
          {isDriveCrumb && <span className="crumb-drive-chev">▾</span>}
          {isDriveCrumb && !measured && (
            <span
              className="crumb-drive-hitzone"
              data-tooltip={t('filePane.changeDriveTooltip')}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onDriveMenuOpen!(event);
              }}
            />
          )}
        </span>
      </React.Fragment>
    );
  };

  return (
    <div
      className="pane-path"
      ref={containerRef}
      onClick={startEditing}
      role={editing ? undefined : 'button'}
      tabIndex={editing ? undefined : 0}
      aria-label={editing ? undefined : t('filePane.editPathAriaLabel')}
      onKeyDown={(event) => {
        if (editing || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        startEditing();
      }}
    >
      {editing ? (
        <input
          className="path-input"
          autoFocus
          value={value}
          onClick={(event) => event.stopPropagation()}
          onFocus={(event) => event.target.select()}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') commit();
            if (event.key === 'Escape') setEditing(false);
          }}
          onBlur={() => setEditing(false)}
        />
      ) : (
        crumbs.map((crumb, index) => {
          if (index > 0 && index < tailStart) return null;
          return (
            <React.Fragment key={crumb.path}>
              {index === tailStart && tailStart > 1 && (
                <>
                  <span className="sep">/</span>
                  <span className="crumb crumb-ellipsis">…</span>
                </>
              )}
              {renderCrumb(crumb, index)}
            </React.Fragment>
          );
        })
      )}
      <div className="pane-path pane-path-measure" ref={measureRef} aria-hidden="true">
        {crumbs.map((crumb, index) => renderCrumb(crumb, index, true))}
        <span className="crumb crumb-ellipsis">…</span>
      </div>
    </div>
  );
}
