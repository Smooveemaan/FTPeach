import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import useDismissableOverlay from '../hooks/useDismissableOverlay.ts';
import { useTruncated } from '../hooks/useTruncated.ts';
import TruncatedText from './TruncatedText.tsx';

export interface SelectMenuOption<T extends string | number> {
  value: T;
  label: ReactNode;
}

interface SelectMenuProps<T extends string | number> {
  value: T;
  options: readonly SelectMenuOption<T>[];
  onChange: (value: T) => void;
  label?: string;
  disabled?: boolean;
  fitToOptions?: boolean;
  rootClassName: string;
  triggerClassName: string;
  dropdownClassName: string;
  valueClassName?: string;
  caretClassName: string;
}

export default function SelectMenu<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled,
  fitToOptions = false,
  rootClassName,
  triggerClassName,
  dropdownClassName,
  valueClassName,
  caretClassName,
}: SelectMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const currentIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const dismiss = useCallback(() => setOpen(false), []);
  useDismissableOverlay({ open, rootRef, onDismiss: dismiss, restoreFocusRef: triggerRef });

  useEffect(() => {
    if (!open) return;
    const option = optionRefs.current[currentIndex];
    option?.focus();
    option?.scrollIntoView({ block: 'nearest' });
  }, [currentIndex, open]);

  const moveFocus = (index: number, key: string) => {
    const last = options.length - 1;
    const next =
      key === 'Home'
        ? 0
        : key === 'End'
          ? last
          : key === 'ArrowDown'
            ? (index + 1) % options.length
            : (index - 1 + options.length) % options.length;
    optionRefs.current[next]?.focus();
  };
  const current = options[currentIndex];
  const [valueRef, valueTruncated] = useTruncated<HTMLSpanElement>([current?.label]);

  return (
    <div className={`${rootClassName}${fitToOptions ? ' select-menu-fit' : ''}`} ref={rootRef}>
      {fitToOptions && (
        <div className={`menu-dropdown ${dropdownClassName} select-menu-sizer`} aria-hidden="true">
          <div className="menu-items">
            {options.map((option) => (
              <span key={option.value} className="menu-item">
                <span className="menu-item-check">✓</span>
                <span className="menu-item-label">{option.label}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      <button
        ref={triggerRef}
        type="button"
        className={`${triggerClassName} ${open ? 'active' : ''}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((previous) => !previous)}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span
          ref={valueRef}
          className={`${valueClassName ?? ''}${valueTruncated ? ' truncated' : ''}`}
        >
          {current?.label}
        </span>
        <span className={caretClassName} aria-hidden="true">
          ▾
        </span>
      </button>
      {open && !disabled && (
        <div className={`menu-dropdown ${dropdownClassName}`}>
          <div className="menu-items" role="listbox" aria-label={label}>
            {options.map((option, index) => (
              <button
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                type="button"
                key={option.value}
                role="option"
                aria-selected={option.value === value}
                className={`menu-item ${option.value === value ? 'active' : ''}`}
                onKeyDown={(event) => {
                  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  moveFocus(index, event.key);
                }}
                onClick={() => {
                  if (option.value !== value) onChange(option.value);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                <span className="menu-item-check">{option.value === value ? '✓' : ''}</span>
                <TruncatedText className="menu-item-label">{option.label}</TruncatedText>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
