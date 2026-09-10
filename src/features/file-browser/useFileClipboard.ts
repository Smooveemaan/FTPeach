import type { MouseEvent, MutableRefObject } from 'react';
import { useRef, useState } from 'react';
import type { DragEntry, DragInfo } from './components/useDragMove.ts';
import { useDragMove } from './components/useDragMove.ts';
import { api } from '../../platform/api/index.ts';
import { reportAsyncFailure, reportRejection } from '../../shared/asyncFailure.ts';
import { commandResultError } from '../../shared/errorMessages.ts';
import type { useTransfers } from '../transfers/index.ts';
import { paneJoin } from './panes/paneBackend.ts';
import type { PaneId, PaneState } from './panes/paneModel.ts';
import type { usePanes } from './usePanes.ts';

interface ClipboardState {
  id: PaneId;
  pane: PaneState;
  mode: 'copy' | 'cut';
}

interface FileClipboardOptions {
  confirmOverwriteIfNeeded: ReturnType<typeof usePanes>['confirmOverwriteIfNeeded'];
  copyEntries: ReturnType<typeof useTransfers>['copyEntries'];
  canCopyBetween: ReturnType<typeof usePanes>['canCopyBetween'];
  refreshPane: ReturnType<typeof usePanes>['refreshPane'];
  movePaneSamePane: ReturnType<typeof usePanes>['movePaneSamePane'];
  panes: Record<PaneId, PaneState>;
}

export interface FileClipboardModel {
  copyToClipboard: (id: PaneId, pane: PaneState) => void;
  cutToClipboard: (id: PaneId, pane: PaneState) => void;
  canPaste: (targetPane: PaneState) => boolean;
  pasteClipboard: (targetId: PaneId, targetPane: PaneState) => void;
  copySelectedWithConfirm: (
    sourcePane: PaneState,
    targetPane: PaneState,
    refreshSource: () => unknown,
    refreshTarget: () => unknown,
  ) => Promise<void>;
  dragMove: {
    startDrag: (side: PaneId, names: string[], entry: DragEntry, e: MouseEvent) => void;
    cancelDrag: () => void | undefined;
    ghostRef: MutableRefObject<HTMLDivElement | null>;
    dragInfo: DragInfo | null;
  };
  outboundDragRef: MutableRefObject<boolean>;
}

export function useFileClipboard({
  confirmOverwriteIfNeeded,
  copyEntries,
  canCopyBetween,
  refreshPane,
  movePaneSamePane,
  panes,
}: FileClipboardOptions): FileClipboardModel {
  const copySelectedWithConfirm = (
    sourcePane: PaneState,
    targetPane: PaneState,
    refreshSource: () => unknown,
    refreshTarget: () => unknown,
  ) =>
    confirmOverwriteIfNeeded(
      targetPane,
      undefined,
      [...sourcePane.selected],
      (namesToUse: string[], overwriteApproved: boolean) =>
        copyEntries({
          sourcePane,
          targetPane,
          names: namesToUse,
          move: false,
          refreshSource,
          refreshTarget,
          overwriteApproved,
        }),
      sourcePane.entries,
    );

  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  const copyToClipboard = (id: PaneId, pane: PaneState) => setClipboard({ id, pane, mode: 'copy' });
  const cutToClipboard = (id: PaneId, pane: PaneState) => setClipboard({ id, pane, mode: 'cut' });
  const canPaste = (targetPane: PaneState) =>
    !!clipboard && clipboard.pane.selected.size > 0 && canCopyBetween(clipboard.pane, targetPane);
  const pasteClipboard = (targetId: PaneId, targetPane: PaneState) => {
    if (!clipboard) return;
    const { id: sourceId, pane: sourcePane, mode } = clipboard;
    reportRejection(
      confirmOverwriteIfNeeded(
        targetPane,
        undefined,
        [...sourcePane.selected],
        (namesToUse: string[], overwriteApproved: boolean) =>
          copyEntries({
            sourcePane,
            targetPane,
            names: namesToUse,
            move: mode === 'cut',
            refreshSource: () => refreshPane(sourceId, sourcePane.path),
            refreshTarget: () => refreshPane(targetId, targetPane.path),
            overwriteApproved,
          })
            .then(() => {
              if (mode === 'cut') setClipboard(null);
            })
            .catch((error: unknown) => console.error('Paste failed', error)),
        sourcePane.entries,
      ),
    );
  };

  // Set while a native OS drag session is live, after the user dragged a
  // remote file past the window edge. useFileDragDrop checks this to avoid
  // mistaking our own outbound drag for an inbound OS file drop when the
  // cursor re-enters the window mid-drag.
  const outboundDragRef = useRef(false);

  // Delivery is lazy (see native_drag::windows on the Rust side): the native
  // drag starts immediately, and the OS only pulls file bytes from us once a
  // drop target actually asks for them. That's what lets this call happen
  // synchronously off the mouse event with no download beforehand -- Windows'
  // DoDragDrop must be entered while the mouse button is still physically
  // held, which an upfront download would almost always race and lose.
  const startNativeDragOut = async (pane: PaneState, names: string[]) => {
    if (!pane.connectionId) return;
    const connectionId = pane.connectionId;
    const files = names
      .map((name) => pane.entries.find((entry) => entry.name === name))
      .filter((entry): entry is NonNullable<typeof entry> => !!entry)
      .map((entry) => ({
        remotePath: paneJoin(pane, entry.name),
        name: entry.name,
        size: entry.size,
        isDirectory: entry.isDirectory,
      }));
    if (files.length !== names.length) return;
    outboundDragRef.current = true;
    try {
      const result = await api.dragOut.start(connectionId, pane.protocol ?? 'ftp', files);
      if (!result.ok) reportAsyncFailure(commandResultError(result));
    } catch (error) {
      reportAsyncFailure(error);
    } finally {
      outboundDragRef.current = false;
    }
  };

  // The local counterpart: the files are already on disk, so the shell does
  // the copying and there is nothing to stream, report or cancel. Still
  // marked outbound, for the same reason the remote drag is -- the cursor
  // re-entering the window mid-drag must not read as an inbound OS drop.
  const startLocalDragOut = async (pane: PaneState, names: string[]) => {
    const paths = names
      .filter((name) => pane.entries.some((entry) => entry.name === name))
      .map((name) => paneJoin(pane, name));
    if (paths.length !== names.length || paths.length === 0) return;
    outboundDragRef.current = true;
    try {
      const result = await api.dragOut.startLocal(paths);
      if (!result.ok) reportAsyncFailure(commandResultError(result));
    } catch (error) {
      reportAsyncFailure(error);
    } finally {
      outboundDragRef.current = false;
    }
  };

  const dragMove = useDragMove(
    ({ sourceSide, names, targetSide, targetFolder, isMove }) => {
      const sourcePane = panes[sourceSide];
      const targetPane = panes[targetSide];
      if (targetSide === sourceSide) {
        if (!targetFolder) return;
        const proceed = (namesToUse: string[]) =>
          movePaneSamePane(sourceSide, namesToUse, targetFolder);
        reportRejection(
          confirmOverwriteIfNeeded(targetPane, targetFolder, names, proceed, sourcePane.entries),
        );
        return;
      }
      const proceed = (namesToUse: string[], overwriteApproved: boolean) =>
        copyEntries({
          sourcePane,
          targetPane,
          names: namesToUse,
          targetFolder,
          move: isMove,
          refreshSource: () => refreshPane(sourceSide, sourcePane.path),
          refreshTarget: () => refreshPane(targetSide, targetPane.path),
          overwriteApproved,
        });
      reportRejection(
        confirmOverwriteIfNeeded(
          targetPane,
          targetFolder ?? undefined,
          names,
          proceed,
          sourcePane.entries,
        ),
      );
    },
    {
      isValidDropTarget: (sourceId, targetId) => canCopyBetween(panes[sourceId], panes[targetId]),
      onDragLeaveWindow: ({ side, names }) => {
        const pane = panes[side];
        if (pane.kind === 'local') {
          if (!pane.path) return;
          dragMove.cancelDrag();
          void startLocalDragOut(pane, names);
          return;
        }
        if (!pane.connectionId) return;
        dragMove.cancelDrag();
        void startNativeDragOut(pane, names);
      },
    },
  );

  return {
    copyToClipboard,
    cutToClipboard,
    canPaste,
    pasteClipboard,
    copySelectedWithConfirm,
    dragMove,
    outboundDragRef,
  };
}
