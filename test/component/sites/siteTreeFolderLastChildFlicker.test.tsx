import type { MutableRefObject } from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import type { DragEndEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core';

import SiteTree from '../../../src/features/sites/SiteTree.tsx';
import { useSiteDragController } from '../../../src/features/sites/useSiteDragController.ts';
import { ROOT } from '../../../src/features/sites/siteDragModel.ts';
import type { SiteDragControllerOptions } from '../../../src/features/sites/useSiteDragController.ts';
import type { ManagedSite } from '../../../src/shared/types.ts';

type SiteDragController = ReturnType<typeof useSiteDragController>;
type CollisionArgs = Parameters<SiteDragController['collisionDetection']>[0];

interface HarnessProps extends SiteDragControllerOptions {
  apiRef: MutableRefObject<SiteDragController | null>;
}

interface MutationBatch {
  label: string;
  records: MutationRecord[];
}

const ROW_H = 38;
const GAP = 2;

function rect(top: number, bottom: number): DOMRect {
  return new DOMRect(0, top, 200, bottom - top);
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
      expandedFolderIds={new Set(['open-a'])}
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

describe("SiteTree: an open folder's own last child during a live cross-container drag", () => {
  test('c2 is never unmounted, remounted, or mutated while drag-site is inserted after it', async () => {
    const entries: ManagedSite[] = [
      { id: 'open-a', kind: 'folder', parentId: null, name: 'open-a' },
      { id: 'c1', kind: 'site', parentId: 'open-a', name: 'c1', protocol: 'ftp' },
      { id: 'c2', kind: 'site', parentId: 'open-a', name: 'c2', protocol: 'ftp' },
      { id: 'r-below', kind: 'site', parentId: null, name: 'r-below', protocol: 'ftp' },
      { id: 'drag-site', kind: 'site', parentId: null, name: 'drag-site', protocol: 'ftp' },
    ];
    const onApplyLayout = () => Promise.resolve({ ok: true });
    const apiRef: MutableRefObject<SiteDragController | null> = { current: null };

    const { container, rerender } = render(
      <Harness entries={entries} onApplyLayout={onApplyLayout} apiRef={apiRef} />,
    );
    const doRerender = () =>
      rerender(<Harness entries={entries} onApplyLayout={onApplyLayout} apiRef={apiRef} />);

    const findRowByName = (name: string) =>
      [...container.querySelectorAll('.site-manage-row.is-site')].find(
        (el) => el.textContent === name,
      );

    const c2Before = findRowByName('c2');
    if (!c2Before) throw new Error('Expected c2 row');

    const batchesOnC2: MutationBatch[] = [];
    let currentLabel = 'start';
    const observer = new MutationObserver((records) => {
      const relevant = records.filter(
        (r) =>
          r.target === c2Before ||
          c2Before.contains(r.target) ||
          [...r.addedNodes, ...r.removedNodes].some((node) => node.contains(c2Before)),
      );
      if (relevant.length > 0) batchesOnC2.push({ label: currentLabel, records: relevant });
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
    });

    // Mirrors real render order: folder header, then its children stacked,
    // then a divider, then the ROOT zone's own rows (r-below, drag-site).
    const layout = () => {
      const controller = apiRef.current;
      if (!controller) throw new Error('Drag controller was not installed');
      const cs = controller.containers;
      let cursor = 0;
      const headerRect = rect(cursor, cursor + ROW_H);
      cursor = headerRect.bottom;
      const childRects = new Map();
      for (const id of cs['open-a'] ?? []) {
        cursor += GAP;
        childRects.set(id, rect(cursor, cursor + ROW_H));
        cursor += ROW_H;
      }
      cursor += GAP;
      const rootRects = new Map();
      for (const id of cs[ROOT]) {
        rootRects.set(id, rect(cursor, cursor + ROW_H));
        cursor += ROW_H + GAP;
      }
      return { headerRect, childRects, rootRects, rootZone: rect(headerRect.bottom, cursor) };
    };

    const headerEl = container.querySelector('.site-manage-row.is-folder');
    if (!(headerEl instanceof HTMLElement)) throw new Error('Expected folder row');
    headerEl.getBoundingClientRect = () => layout().headerRect;

    const active = {
      id: 'drag-site',
      data: { current: { kind: 'site' } },
      rect: { current: { initial: null, translated: null } },
    } as unknown as DragStartEvent['active'];
    const startRect = layout().rootRects.get('drag-site');
    if (!startRect) throw new Error('Expected drag-site rect');
    const startTop = startRect.top;
    active.rect.current.initial = rect(startTop, startTop + ROW_H);
    const controller = apiRef.current;
    if (!controller) throw new Error('Drag controller was not installed');

    act(() => {
      controller.handleDragStart({
        active,
        activatorEvent: new MouseEvent('mousedown', { clientX: 50, clientY: startTop + ROW_H / 2 }),
      } as DragStartEvent);
    });
    doRerender();

    const stepTo = async (top: number) => {
      const l = layout();
      const collisionRect = rect(top, top + ROW_H);
      active.rect.current.translated = collisionRect;
      const droppableRects = new Map([
        [ROOT, l.rootZone],
        ['open-a', l.headerRect],
      ]);
      const droppableContainers = [{ id: ROOT }, { id: 'open-a' }];
      for (const [id, r] of l.rootRects) {
        if (id === active.id) continue;
        droppableRects.set(id, r);
        droppableContainers.push({ id });
      }
      for (const [id, r] of l.childRects) {
        droppableRects.set(id, r);
        droppableContainers.push({ id });
      }
      let collisions: ReturnType<SiteDragController['collisionDetection']> = [];
      act(() => {
        collisions = controller.collisionDetection({
          active,
          collisionRect,
          droppableRects,
          droppableContainers,
          pointerCoordinates: { x: 50, y: top + ROW_H / 2 },
        } as unknown as CollisionArgs);
      });
      const overId = collisions[0]?.id ?? null;
      const overRect =
        overId == null ? null : (droppableRects.get(String(overId)) ?? collisionRect);
      act(() => {
        controller.handleDragOver({
          active,
          over: overId == null ? null : { id: overId, rect: overRect },
        } as unknown as DragOverEvent);
      });
      doRerender();
      currentLabel = `top=${top} over=${overId}`;
      await Promise.resolve();
      await Promise.resolve();
      return overId;
    };

    const overIds = [];
    let landedOnC2 = false;
    let top = startTop;
    while (top >= -20 && !landedOnC2) {
      const overId = await stepTo(top);
      overIds.push(overId);
      if (overId === 'c2') landedOnC2 = true;
      else top -= 1;
    }
    expect(landedOnC2).toBe(true);

    // Hold at that exact pixel a few more frames before releasing, the way a
    // real pointer settles briefly before the button comes up.
    for (let i = 0; i < 5; i += 1) {
      overIds.push(await stepTo(top));
    }

    const lastOverId = overIds.at(-1);
    currentLabel = `drop over=${lastOverId}`;
    act(() => {
      controller.handleDragEnd({
        active,
        over: lastOverId == null ? null : { id: lastOverId, rect: layout().childRects.get('c2') },
      } as unknown as DragEndEvent);
    });
    doRerender();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    doRerender();
    await Promise.resolve();

    observer.disconnect();

    const c2After = findRowByName('c2');
    expect(c2After).toBeTruthy();
    expect(c2After).toBe(c2Before);
    expect(batchesOnC2).toEqual([]);
    expect(apiRef.current!.containers['open-a']).toEqual(['c1', 'c2', 'drag-site']);
  });
});
