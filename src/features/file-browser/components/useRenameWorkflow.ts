import type { Dispatch, SetStateAction } from 'react';
import { useRef, useState } from 'react';
import type { FileEntry } from '../../../shared/types.ts';

export interface RenameWorkflowModel {
  renamingName: string | null;
  value: string;
  setValue: Dispatch<SetStateAction<string>>;
  start: (entry: FileEntry) => void;
  commit: (entry: FileEntry) => void;
  cancel: () => void;
}

export default function useRenameWorkflow(
  onRename?: (entry: FileEntry, newName: string) => unknown,
): RenameWorkflowModel {
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const committedRef = useRef(false);

  const start = (entry: FileEntry) => {
    committedRef.current = false;
    setRenamingName(entry.name);
    setValue(entry.name);
  };

  const commit = (entry: FileEntry) => {
    if (committedRef.current) return;
    committedRef.current = true;
    const nextValue = value.trim();
    setRenamingName(null);
    if (nextValue && nextValue !== entry.name && onRename) onRename(entry, nextValue);
  };

  const cancel = () => {
    committedRef.current = true;
    setRenamingName(null);
  };

  return { renamingName, value, setValue, start, commit, cancel };
}
