import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import { useEffect, useRef, useState } from 'react';

export interface FileSearchHandle {
  focus: () => void;
  toggle: () => void;
}
interface FileSearchOptions {
  currentPath: string;
  externalRef?: MutableRefObject<FileSearchHandle | null> | null | undefined;
}

export interface FileSearchModel {
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  inputRef: RefObject<HTMLInputElement>;
  close: () => void;
}

export default function useFileSearch({
  currentPath,
  externalRef,
}: FileSearchOptions): FileSearchModel {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const close = () => {
    setOpen(false);
    inputRef.current?.blur();
  };

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!externalRef) return;
    externalRef.current = {
      focus: () => setOpen(true),
      toggle: () => (open ? close() : setOpen(true)),
    };
  }, [externalRef, open]);

  useEffect(() => setText(''), [currentPath]);

  return { text, setText, open, setOpen, inputRef, close };
}
