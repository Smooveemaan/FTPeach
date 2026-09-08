import { useEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import Modal from './Modal.tsx';
import Icon from './Icon.tsx';
import TruncatedText from './TruncatedText.tsx';

interface MoveToFolderDialogProps {
  title: ReactNode;
  label: ReactNode;
  folders: string[];
  onSubmit: (name: string) => unknown;
  onClose: () => void;
}

export default function MoveToFolderDialog({
  title,
  label,
  folders,
  onSubmit,
  onClose,
}: MoveToFolderDialogProps) {
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

  const choose = (name: string) => {
    onSubmit(name);
    onClose();
  };

  return (
    <Modal title={title} onClose={onClose} className="modal-move-to">
      <p className="move-to-label">{label}</p>
      <div className="move-to-list" role="menu" ref={listRef} onKeyDown={handleKeyDown}>
        {folders.map((name) => (
          <button
            type="button"
            key={name}
            role="menuitem"
            className="move-to-row"
            onClick={() => choose(name)}
          >
            <span className="move-to-icon">
              <Icon name="fileFolder" size={13} />
            </span>
            <TruncatedText className="move-to-name">{name}</TruncatedText>
          </button>
        ))}
      </div>
    </Modal>
  );
}
