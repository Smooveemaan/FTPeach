import type { ReactNode } from 'react';
import Modal from './Modal.tsx';
import FolderList from './FolderList.tsx';

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
  return (
    <Modal title={title} onClose={onClose} className="modal-move-to">
      <p className="move-to-label">{label}</p>
      <FolderList
        folders={folders.map((name) => ({ key: name, label: name }))}
        onChoose={(name) => {
          onSubmit(name);
          onClose();
        }}
      />
    </Modal>
  );
}
