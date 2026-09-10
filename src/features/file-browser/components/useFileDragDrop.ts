import type {
  MutableRefObject,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OsDragDropPayload } from '../../../platform/api/filesystem.ts';
import { api } from '../../../platform/api/index.ts';
import { handler } from '../../../shared/asyncFailure.ts';
import type { FileEntry } from '../../../shared/types.ts';
import type { PaneId } from '../panes/paneModel.ts';

export interface DroppedFile {
  name: string;
  path: string;
  isDirectory: boolean;
}

type DropFiles = (files: DroppedFile[], targetFolder: string | null) => unknown;

interface FileDragDropOptions {
  side: PaneId;
  sorted: readonly FileEntry[];
  selectedNames: ReadonlySet<string>;
  dragMoveStart: (
    side: PaneId,
    names: string[],
    entry: FileEntry,
    event: ReactMouseEvent<HTMLElement>,
  ) => unknown;
  onDropFiles?: DropFiles | undefined;
  outboundDragRef?: MutableRefObject<boolean> | undefined;
}

interface DragDropState {
  side: PaneId;
  sorted: readonly FileEntry[];
  selectedNames: ReadonlySet<string>;
  dragMoveStart: FileDragDropOptions['dragMoveStart'];
  onDropFiles?: DropFiles | undefined;
  outboundDragRef?: MutableRefObject<boolean> | undefined;
}

export interface FileDragDropModel {
  dragOver: boolean;
  /** The pane is under an OS drag it cannot accept — see the state below. */
  dragRejected: boolean;
  dragOverRowName: string | null;
  handleRowMouseDown: (entry: FileEntry, e: ReactMouseEvent<HTMLElement>) => void;
  handleDragOver: (e: ReactDragEvent<HTMLElement>) => void;
  handleDragLeave: () => void;
  handleDrop: (e: ReactDragEvent<HTMLElement>) => void;
}

export default function useFileDragDrop({
  side,
  sorted,
  selectedNames,
  dragMoveStart,
  onDropFiles,
  outboundDragRef,
}: FileDragDropOptions): FileDragDropModel {
  const [dragOver, setDragOver] = useState(false);
  // A pane with no `onDropFiles` cannot take what the OS is offering — a
  // Server pane that is not connected has nowhere to upload to. It still has
  // to answer the drag: silently swallowing it looked like an accepted drop
  // that did nothing, and letting a disconnected pane take it surfaced a
  // connection error the user could only have avoided by knowing not to drop
  // there. So it shows the same inert "not here" wash the in-app drag already
  // uses for an invalid target.
  const [dragRejected, setDragRejected] = useState(false);
  const [dragOverRowName, setDragOverRowName] = useState<string | null>(null);
  const dragClearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragStateRef = useRef<DragDropState>({
    side,
    sorted,
    selectedNames,
    dragMoveStart,
    onDropFiles,
    outboundDragRef,
  });
  dragStateRef.current = {
    side,
    sorted,
    selectedNames,
    dragMoveStart,
    onDropFiles,
    outboundDragRef,
  };

  const handleRowMouseDown = useCallback((entry: FileEntry, e: ReactMouseEvent<HTMLElement>) => {
    if (e.target instanceof Element && e.target.closest('input, .col-resize-handle')) return;
    const { side, selectedNames, dragMoveStart } = dragStateRef.current;
    const names = selectedNames.has(entry.name) ? [...selectedNames] : [entry.name];
    dragMoveStart(side, names, entry, e);
  }, []);

  const armDragClear = () => {
    if (dragClearTimeoutRef.current) clearTimeout(dragClearTimeoutRef.current);
    dragClearTimeoutRef.current = setTimeout(() => {
      setDragOver(false);
      setDragRejected(false);
      setDragOverRowName(null);
      document.body.classList.remove('drag-move-active');
    }, 200);
  };
  useEffect(
    () => () => {
      if (dragClearTimeoutRef.current) clearTimeout(dragClearTimeoutRef.current);
    },
    [],
  );

  const rowFromEvent = (e: ReactDragEvent<HTMLElement>): FileEntry | null => {
    const rowEl = e.target instanceof Element ? e.target.closest<HTMLElement>('.row') : null;
    if (!rowEl) return null;
    return sorted.find((en) => en.name === rowEl.dataset.name) || null;
  };

  const handleDragOver = (e: ReactDragEvent<HTMLElement>) => {
    e.preventDefault();
    const accepts = !!dragStateRef.current.onDropFiles;
    e.dataTransfer.dropEffect = accepts ? 'copy' : 'none';
    setDragRejected(!accepts);
    document.body.classList.add('drag-move-active');
    const entry = accepts ? rowFromEvent(e) : null;
    const overFolder = entry && entry.isDirectory ? entry.name : null;
    if (overFolder) {
      if (dragOver) setDragOver(false);
      if (dragOverRowName !== overFolder) setDragOverRowName(overFolder);
    } else {
      if (!dragOver) setDragOver(true);
      if (dragOverRowName) setDragOverRowName(null);
    }
    armDragClear();
  };

  const handleDragLeave = () => armDragClear();

  const handleDrop = (e: ReactDragEvent<HTMLElement>) => {
    e.preventDefault();
    if (dragClearTimeoutRef.current) clearTimeout(dragClearTimeoutRef.current);
    const entry = rowFromEvent(e);
    const targetFolder = entry && entry.isDirectory ? entry.name : null;
    setDragOver(false);
    setDragRejected(false);
    setDragOverRowName(null);
    document.body.classList.remove('drag-move-active');
    if (e.dataTransfer.files.length === 0 || !onDropFiles) return;
    const items = e.dataTransfer.items;
    const files = Array.from(e.dataTransfer.files)
      .map((f, i) => ({
        name: f.name,
        path: api.fsLocal.pathForFile(f),
        isDirectory: !!items[i]?.webkitGetAsEntry()?.isDirectory,
      }))
      .filter((file): file is DroppedFile => typeof file.path === 'string');
    if (files.length > 0) onDropFiles(files, targetFolder);
  };

  useEffect(() => {
    const elementAtPoint = (point: OsDragDropPayload['point']) =>
      point && document.elementFromPoint(point.x, point.y);
    const isOwnPane = (el: Element | null) =>
      el?.closest<HTMLElement>('[data-side]')?.dataset.side === dragStateRef.current.side;
    const folderNameAtPoint = (point: OsDragDropPayload['point']) => {
      const rowEl = elementAtPoint(point)?.closest<HTMLElement>('.row');
      if (!rowEl) return null;
      const entry = dragStateRef.current.sorted.find((en) => en.name === rowEl.dataset.name);
      return entry && entry.isDirectory ? entry.name : null;
    };
    const clear = () => {
      if (dragClearTimeoutRef.current) clearTimeout(dragClearTimeoutRef.current);
      setDragOver(false);
      setDragRejected(false);
      setDragOverRowName(null);
      document.body.classList.remove('drag-move-active');
    };
    return api.fsLocal.onOsDragDrop(
      handler(async (evt: OsDragDropPayload) => {
        if (evt.type === 'leave' || !isOwnPane(elementAtPoint(evt.point))) {
          clear();
          return;
        }
        if (evt.type === 'enter' || evt.type === 'over') {
          if (dragStateRef.current.outboundDragRef?.current) return;
          if (dragClearTimeoutRef.current) clearTimeout(dragClearTimeoutRef.current);
          const accepts = !!dragStateRef.current.onDropFiles;
          const overFolder = accepts ? folderNameAtPoint(evt.point) : null;
          setDragOver(!overFolder);
          setDragRejected(!accepts);
          setDragOverRowName(overFolder);
          document.body.classList.add('drag-move-active');
          return;
        }
        // Only 'drop' events reach this point.
        const targetFolder = folderNameAtPoint(evt.point);
        clear();
        const { onDropFiles: drop, outboundDragRef: outbound } = dragStateRef.current;
        // Our own drag-out, dropped back inside the window: the paths are the
        // pane's own entries, and a local pane would try to copy them onto
        // themselves.
        if (outbound?.current) return;
        if (!evt.paths || evt.paths.length === 0 || !drop) return;
        const files = await Promise.all(
          evt.paths.map(async (path) => ({
            name: path.split(/[\\/]/).filter(Boolean).pop() || path,
            path,
            isDirectory: Boolean(await api.fsLocal.isDir(path)),
          })),
        );
        drop(files, targetFolder);
      }),
    );
  }, []);

  return {
    dragOver,
    dragRejected,
    dragOverRowName,
    handleRowMouseDown,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
