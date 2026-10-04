import type {
  MutableRefObject,
  RefObject,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OsDragDropPayload } from '../../../platform/api/filesystem.ts';
import { api } from '../../../platform/api/index.ts';
import { getInterfaceScale } from '../../../platform/interfaceScale.ts';
import { handler } from '../../../shared/asyncFailure.ts';
import type { FileEntry } from '../../../shared/paneContracts.ts';
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
  showGhost: boolean;
  /** The "Copy" badge beside the cursor, moved by hand so a drag does not re-render the pane. */
  ghostRef: RefObject<HTMLDivElement | null>;
  dragOverPath: string | null;
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
  const [showGhost, setShowGhost] = useState(false);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const moveGhost = (point: { x: number; y: number } | null) => {
    setShowGhost(!!point);
    const el = ghostRef.current;
    if (!el || !point) return;
    const scale = getInterfaceScale();
    el.style.transform = `translate(${point.x / scale + 14}px, ${point.y / scale - 12}px)`;
  };
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const crumbPath = (el: EventTarget | null) =>
    el instanceof Element
      ? (el.closest<HTMLElement>('[data-drop-path]')?.dataset.dropPath ?? null)
      : null;
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
      setShowGhost(false);
      setDragOverPath(null);
      setDragRejected(false);
      setDragOverRowName(null);
      document.body.classList.remove('drag-move-active', 'drag-drop-forbidden');
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

  const isDropArea = (el: EventTarget | null) =>
    el instanceof Element && !!el.closest('.pane-list, [data-drop-path]');

  const handleDragOver = (e: ReactDragEvent<HTMLElement>) => {
    e.preventDefault();
    const accepts =
      !!dragStateRef.current.onDropFiles &&
      isDropArea(e.target) &&
      !dragStateRef.current.outboundDragRef?.current;
    e.dataTransfer.dropEffect = accepts ? 'copy' : 'none';
    setDragRejected(!dragStateRef.current.onDropFiles);
    document.body.classList.toggle('drag-drop-forbidden', !accepts);
    document.body.classList.add('drag-move-active');
    moveGhost(accepts ? { x: e.clientX, y: e.clientY } : null);
    const path = accepts ? crumbPath(e.target) : null;
    setDragOverPath(path);
    const entry = accepts ? rowFromEvent(e) : null;
    const overFolder = entry && entry.isDirectory ? entry.name : null;
    if (overFolder || path) {
      if (dragOver) setDragOver(false);
      if (dragOverRowName !== overFolder) setDragOverRowName(overFolder);
    } else {
      // The wash means "drops here" (or, on a pane that takes nothing, "not
      // here"): not over a spot in a pane that takes drops but not there.
      const wash = accepts || !dragStateRef.current.onDropFiles;
      if (dragOver !== wash) setDragOver(wash);
      if (dragOverRowName) setDragOverRowName(null);
    }
    armDragClear();
  };

  const handleDragLeave = () => armDragClear();

  const handleDrop = (e: ReactDragEvent<HTMLElement>) => {
    e.preventDefault();
    if (dragClearTimeoutRef.current) clearTimeout(dragClearTimeoutRef.current);
    const entry = rowFromEvent(e);
    const targetFolder = crumbPath(e.target) ?? (entry && entry.isDirectory ? entry.name : null);
    setDragOver(false);
    setShowGhost(false);
    setDragOverPath(null);
    setDragRejected(false);
    setDragOverRowName(null);
    document.body.classList.remove('drag-move-active', 'drag-drop-forbidden');
    if (
      e.dataTransfer.files.length === 0 ||
      !onDropFiles ||
      !isDropArea(e.target) ||
      outboundDragRef?.current
    )
      return;
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
    const paneSideAt = (point: OsDragDropPayload['point']) => {
      if (!point) return undefined;
      for (const pane of document.querySelectorAll<HTMLElement>('.pane[data-side]')) {
        const r = pane.getBoundingClientRect();
        if (point.x >= r.left && point.x < r.right && point.y >= r.top && point.y < r.bottom)
          return pane.dataset.side;
      }
      return undefined;
    };
    const folderNameAt = (el: Element | null) => {
      const crumb = crumbPath(el);
      if (crumb) return crumb;
      const rowEl = el?.closest<HTMLElement>('.row');
      if (!rowEl) return null;
      const entry = dragStateRef.current.sorted.find((en) => en.name === rowEl.dataset.name);
      return entry && entry.isDirectory ? entry.name : null;
    };
    const clear = (bodyToo: boolean) => {
      if (dragClearTimeoutRef.current) clearTimeout(dragClearTimeoutRef.current);
      setDragOver(false);
      setShowGhost(false);
      setDragOverPath(null);
      setDragRejected(false);
      setDragOverRowName(null);
      if (bodyToo) document.body.classList.remove('drag-move-active', 'drag-drop-forbidden');
    };
    return api.fsLocal.onOsDragDrop(
      handler(async (evt: OsDragDropPayload) => {
        // One hit test per event, shared by everything below: each pane gets
        // every event, and hit tests after a class change on <body> restyle
        // the whole document.
        const el = elementAtPoint(evt.point);
        // While `drag-move-active` is on, only drop areas answer a hit test,
        // so over a column header the test lands on <body>. The pane is still
        // the one under the cursor: losing it there would take the classes
        // off <body> and the next event put them back, restyling the whole
        // document twice an event until the events piled up.
        const paneSide =
          el?.closest<HTMLElement>('[data-side]')?.dataset.side ?? paneSideAt(evt.point);
        // Outside every pane nothing takes the drop, and the cursor says so;
        // once the drag leaves, the next one starts from "takes it".
        if (evt.type === 'leave' || evt.type === 'drop') api.fsLocal.setDropAllowed(true);
        else if (paneSide === undefined) api.fsLocal.setDropAllowed(false);
        if (evt.type === 'leave' || paneSide !== dragStateRef.current.side) {
          // The body classes belong to the pane under the cursor; a pane the
          // cursor is not over must not take them away from it.
          clear(evt.type === 'leave' || paneSide === undefined);
          return;
        }
        if (evt.type === 'enter' || evt.type === 'over') {
          if (dragStateRef.current.outboundDragRef?.current) return;
          if (dragClearTimeoutRef.current) clearTimeout(dragClearTimeoutRef.current);
          const accepts = !!dragStateRef.current.onDropFiles && isDropArea(el);
          const overFolder = accepts ? folderNameAt(el) : null;
          const path = accepts ? crumbPath(el) : null;
          moveGhost(accepts ? evt.point : null);
          setDragOverPath(path);
          setDragOver(!overFolder && (accepts || !dragStateRef.current.onDropFiles));
          setDragRejected(!dragStateRef.current.onDropFiles);
          document.body.classList.toggle('drag-drop-forbidden', !accepts);
          api.fsLocal.setDropAllowed(accepts);
          setDragOverRowName(path ? null : overFolder);
          document.body.classList.add('drag-move-active');
          return;
        }
        // Only 'drop' events reach this point.
        const targetFolder = folderNameAt(el);
        clear(true);
        const { onDropFiles: drop, outboundDragRef: outbound } = dragStateRef.current;
        // Our own drag-out, dropped back inside the window: the paths are the
        // pane's own entries, and a local pane would try to copy them onto
        // themselves.
        if (outbound?.current) return;
        if (!evt.paths || evt.paths.length === 0 || !drop || !isDropArea(el)) return;
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
    showGhost,
    ghostRef,
    dragOverPath,
    dragRejected,
    dragOverRowName,
    handleRowMouseDown,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
