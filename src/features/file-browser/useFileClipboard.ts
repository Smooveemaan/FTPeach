import type { MouseEvent, MutableRefObject } from 'react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DragEntry, DragInfo, DropMenu } from './components/useDragMove.ts';
import { useDragMove } from './components/useDragMove.ts';
import { api } from '../../platform/api/index.ts';
import { reportAsyncFailure, reportRejection } from '../../shared/asyncFailure.ts';
import { commandResultError } from '../../shared/errorMessages.ts';
import { canMoveBetween } from '../../shared/movePolicy.ts';
import type { TransfersModel } from '../transfers/index.ts';
import { resolveDropAction } from './components/dropAction.ts';
import { paneJoin } from './panes/paneBackend.ts';
import type { PaneId, PaneState } from './panes/paneModel.ts';
import type { PanesModel } from './usePanes.ts';

interface ClipboardState {
  id: PaneId;
  pane: PaneState;
  mode: 'copy' | 'cut';
}

interface FileClipboardOptions {
  browser: Pick<
    PanesModel,
    'panes' | 'confirmOverwriteIfNeeded' | 'canCopyBetween' | 'refreshPaneIfAt'
  >;
  transfers: Pick<TransfersModel, 'copyEntries'>;
}

export interface FileClipboardModel {
  copyToClipboard: (id: PaneId, pane: PaneState) => void;
  cutToClipboard: (id: PaneId, pane: PaneState) => void;
  canPaste: (targetPane: PaneState) => boolean;
  cutNames: (pane: PaneState) => ReadonlySet<string> | undefined;
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
    dropMenu: DropMenu | null;
    closeDropMenu: () => void;
  };
  outboundDragRef: MutableRefObject<boolean>;
}

export function useFileClipboard({ browser, transfers }: FileClipboardOptions): FileClipboardModel {
  const { panes, confirmOverwriteIfNeeded, canCopyBetween, refreshPaneIfAt } = browser;
  const { copyEntries } = transfers;
  const { t } = useTranslation();
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
  /** The names a cut is holding in this folder, which the list shows paler. */
  const cutNames = (pane: PaneState): ReadonlySet<string> | undefined =>
    clipboard?.mode === 'cut' &&
    clipboard.pane.kind === pane.kind &&
    clipboard.pane.path === pane.path &&
    clipboard.pane.connectionId === pane.connectionId
      ? clipboard.pane.selected
      : undefined;
  const canPaste = (targetPane: PaneState) =>
    !!clipboard && clipboard.pane.selected.size > 0 && canCopyBetween(clipboard.pane, targetPane);
  const pasteClipboard = (targetId: PaneId, targetPane: PaneState) => {
    if (!clipboard) return;
    const { id: sourceId, pane: sourcePane, mode } = clipboard;
    // The cut stays on the clipboard, so the user can still copy it instead.
    if (mode === 'cut' && !canMoveBetween(sourcePane, targetPane)) {
      reportAsyncFailure(t('errors.moveBetweenEndpoints'));
      return;
    }
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
            refreshSource: () => refreshPaneIfAt(sourceId, sourcePane.path),
            refreshTarget: () => refreshPaneIfAt(targetId, targetPane.path),
            overwriteApproved,
          })
            .then((result) => {
              // A cut whose files are still where they were is not spent: the
              // user can paste it again once the reason is out of the way.
              if (mode === 'cut' && result.ok && !result.sourceRetained) setClipboard(null);
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
      const proceed = (namesToUse: string[], overwriteApproved: boolean) =>
        copyEntries({
          sourcePane,
          targetPane,
          names: namesToUse,
          targetFolder,
          move: isMove,
          refreshSource: () => refreshPaneIfAt(sourceSide, sourcePane.path),
          refreshTarget: () => refreshPaneIfAt(targetSide, targetPane.path),
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
      resolveAction: (sourceId, targetId, folder, names, keys) =>
        canCopyBetween(panes[sourceId], panes[targetId])
          ? resolveDropAction(panes[sourceId], panes[targetId], folder, names, keys)
          : 'invalid',
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
    cutNames,
    pasteClipboard,
    copySelectedWithConfirm,
    dragMove,
    outboundDragRef,
  };
}
