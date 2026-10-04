import { useEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import Icon from './Icon.tsx';
import TruncatedText from './TruncatedText.tsx';

export interface FolderListItem {
  key: string;
  label: ReactNode;
}

/** A list of folders to pick one from, arrow keys moving between them:
 * Move to (F6) and the folders the path bar has no room for. */
export default function FolderList({
  folders,
  onChoose,
}: {
  folders: readonly FolderListItem[];
  onChoose: (key: string) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.querySelector('button')?.focus();
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const buttons = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('button') || [],
    );
    if (buttons.length === 0) return;
    e.preventDefault();
    const current = buttons.findIndex((button) => button === document.activeElement);
    let next;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    else if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % buttons.length;
    else next = current < 0 ? buttons.length - 1 : (current - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div className="move-to-list" role="menu" ref={listRef} onKeyDown={handleKeyDown}>
      {folders.map(({ key, label }) => (
        <button
          type="button"
          key={key}
          role="menuitem"
          className="move-to-row"
          onClick={() => onChoose(key)}
          // The pointer moves the focus, so one row is lit, as in a menu.
          onMouseMove={(e) => e.currentTarget.focus({ preventScroll: true })}
        >
          <span className="move-to-icon">
            <Icon name="fileFolder" size={13} />
          </span>
          <TruncatedText
            className="move-to-name"
            tooltip={typeof label === 'string' ? label : undefined}
          >
            {label}
          </TruncatedText>
        </button>
      ))}
    </div>
  );
}
