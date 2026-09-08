import Icon from '../../../components/Icon.tsx';
import type { RefObject } from 'react';
import type { PaneId } from '../panes/paneModel.ts';
import type { Translate } from './fileListModel.ts';

interface SearchFilterProps {
  side: PaneId;
  open: boolean;
  value: string;
  inputRef: RefObject<HTMLInputElement>;
  onOpen: () => void;
  onClose: () => void;
  onChange: (value: string) => void;
  t: Translate;
}

export default function SearchFilter({
  side,
  open,
  value,
  inputRef,
  onOpen,
  onClose,
  onChange,
  t,
}: SearchFilterProps) {
  const shortcut = side === 'b' ? 'Ctrl+Shift+F' : 'Ctrl+F';
  return (
    <>
      <button
        type="button"
        className={`btn btn-primary btn-primary-quiet btn-icon pane-search-toggle ${open ? 'active' : ''}`}
        data-tooltip={t('filePane.searchTooltip', { shortcut })}
        onClick={() => (open ? onClose() : onOpen())}
      >
        <Icon name="search" size={13} />
      </button>
      <div className="pane-filter">
        <input
          ref={inputRef}
          type="text"
          tabIndex={open ? undefined : -1}
          placeholder={t('filePane.searchPlaceholder', { shortcut })}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={onOpen}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              onChange('');
              onClose();
            }
          }}
        />
        {value && (
          <button type="button" className="filter-clear" onClick={() => onChange('')}>
            ✕
          </button>
        )}
      </div>
    </>
  );
}
