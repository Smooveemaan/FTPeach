import type { MutableRefObject } from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { DragEndEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core';

import SiteTree from '../../../src/features/sites/SiteTree.tsx';
import { useSiteDragController } from '../../../src/features/sites/useSiteDragController.ts';
import type { SiteDragControllerOptions } from '../../../src/features/sites/useSiteDragController.ts';
import type { ManagedSite } from '../../../src/shared/types.ts';

type SiteDragController = ReturnType<typeof useSiteDragController>;

interface HarnessProps extends SiteDragControllerOptions {
  apiRef: MutableRefObject<SiteDragController | null>;
}

function Harness({ entries, onApplyLayout, apiRef }: HarnessProps) {
  const controller = useSiteDragController({ entries, onApplyLayout });
  apiRef.current = controller;
  return (
    <SiteTree
      sensors={controller.sensors}
      collisionDetection={controller.collisionDetection}
      modifiers={controller.modifiers}
      onDragStart={controller.handleDragStart}
      onDragOver={controller.handleDragOver}
      onDragEnd={controller.handleDragEnd}
      onDragCancel={controller.handleDragCancel}
      activeId={controller.activeId}
      activeEntry={controller.activeEntry}
      activeRect={controller.activeRect}
      canCollapseSource={controller.canCollapseSource}
      localEntries={controller.localEntries}
      addingFolder={false}
      newFolderName=""
      onNewFolderNameChange={() => {}}
      onCommitAddFolder={() => {}}
      onCancelAddFolder={() => {}}
      containers={controller.containers}
      dragContentHeight={controller.dragContentHeight}
      entriesById={controller.entriesById}
      expandedFolderIds={new Set(['f1'])}
      renamingFolderId={null}
      renameFolderName=""
      renamingSiteId={null}
      renameSiteName=""
      dropTargetFolderId={controller.dropTargetFolderId}
      onRenameFolderNameChange={() => {}}
      onCommitRenameFolder={() => {}}
      onCancelRenameFolder={() => {}}
      onRenameSiteNameChange={() => {}}
      onCommitRenameSite={() => {}}
      onCancelRenameSite={() => {}}
      onStartRenameSite={() => {}}
      onToggleFolder={() => {}}
      onStartRenameFolder={() => {}}
      onRequestDelete={() => {}}
      onConnect={() => {}}
      onEdit={() => {}}
      onDuplicate={() => {}}
      onCreateInFolder={() => {}}
      registerRowNode={controller.registerRowNode}
      t={(key) => key}
    />
  );
}

describe('SiteTree: dropping a root bookmark onto a folder header', () => {
  test('the moved row reaches the folder in one DOM mutation batch', async () => {
    const entries: ManagedSite[] = [
      { id: 'f1', kind: 'folder', parentId: null, name: 'Folder 1' },
      { id: 'existing', kind: 'site', parentId: 'f1', name: 'existing-child', protocol: 'ftp' },
      { id: 'drag-site', kind: 'site', parentId: null, name: 'drag-site', protocol: 'ftp' },
    ];
    const onApplyLayout = vi.fn(async () => ({ ok: true }));
    const apiRef: MutableRefObject<SiteDragController | null> = { current: null };

    const { container } = render(
      <Harness entries={entries} onApplyLayout={onApplyLayout} apiRef={apiRef} />,
    );
    const findDragRow = () =>
      [...container.querySelectorAll('.site-manage-row.is-site')].find(
        (el) => el.textContent === 'drag-site',
      );

    const nodeBefore = findDragRow();
    expect(nodeBefore).toBeTruthy();

    const batches: MutationRecord[][] = [];
    const observer = new MutationObserver((records) => {
      batches.push(records);
    });

    const active = {
      id: 'drag-site',
      data: { current: { kind: 'site' } },
      rect: { current: { initial: null, translated: null } },
    };
    const controller = apiRef.current;
    if (!controller) throw new Error('Drag controller was not installed');

    await act(async () => {
      controller.handleDragStart({
        active,
        activatorEvent: new MouseEvent('mousedown', { clientX: 0, clientY: 0 }),
      } as DragStartEvent);
    });
    await act(async () => {
      apiRef.current!.handleDragOver({ active, over: { id: 'f1' } } as unknown as DragOverEvent);
    });
    observer.observe(container, { childList: true, subtree: true, attributes: true });
    try {
      await act(async () => {
        apiRef.current!.handleDragEnd({ active, over: { id: 'f1' } } as unknown as DragEndEvent);
      });
    } finally {
      observer.disconnect();
    }

    const nodeAfter = findDragRow();
    expect(nodeAfter).toBeTruthy();
    expect(apiRef.current!.containers['f1']).toEqual(['existing', 'drag-site']);
    expect(nodeAfter?.closest('[role="group"]')?.parentElement?.dataset.rowId).toBe('f1');
    expect(onApplyLayout).toHaveBeenCalledWith([
      { id: 'f1', parentId: null },
      { id: 'existing', parentId: 'f1' },
      { id: 'drag-site', parentId: 'f1' },
    ]);

    const relevantBatches = batches.filter((records) =>
      records.some(
        (r) =>
          r.type === 'attributes' ||
          [...r.addedNodes, ...r.removedNodes].some(
            (node) =>
              node instanceof Element &&
              (node === nodeBefore ||
                node === nodeAfter ||
                (nodeAfter && node.contains(nodeAfter))),
          ),
      ),
    );

    expect(relevantBatches).toHaveLength(1);
  });
});
