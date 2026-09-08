import { act, renderHook } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import type { DragOverEvent, DragStartEvent } from '@dnd-kit/core';

import { useSiteDragController } from '../../../src/features/sites/useSiteDragController.ts';
import { ROOT } from '../../../src/features/sites/siteDragModel.ts';
import type { ManagedSite, SiteContainers } from '../../../src/shared/types.ts';

type SiteDragController = ReturnType<typeof useSiteDragController>;
type ControllerResult = { current: SiteDragController };
type Active = DragStartEvent['active'];
type CollisionArgs = Parameters<SiteDragController['collisionDetection']>[0];

interface ComputedLayout {
  headerRects: Map<string, DOMRect>;
  childRectsByFolder: Map<string, Map<string, DOMRect>>;
  bottom: number;
}

const ROW_H = 38;
const GAP = 2;

function rect(top: number, bottom: number): DOMRect {
  return new DOMRect(0, top, 200, bottom - top);
}

function computeLayout(
  folderIds: readonly string[],
  expandedFolderIds: ReadonlySet<string>,
  containers: SiteContainers,
): ComputedLayout {
  const headerRects = new Map<string, DOMRect>();
  const childRectsByFolder = new Map<string, Map<string, DOMRect>>();
  let cursor = 0;
  for (const folderId of folderIds) {
    const header = rect(cursor, cursor + ROW_H);
    headerRects.set(folderId, header);
    cursor = header.bottom;
    if (expandedFolderIds.has(folderId)) {
      const childIds = containers[folderId] || [];
      const childRects = new Map<string, DOMRect>();
      for (const id of childIds) {
        cursor += GAP;
        const childRect = rect(cursor, cursor + ROW_H);
        childRects.set(id, childRect);
        cursor = childRect.bottom;
      }
      childRectsByFolder.set(folderId, childRects);
    }
    cursor += GAP;
  }
  return { headerRects, childRectsByFolder, bottom: cursor };
}

function registerLiveFolderNodes(
  result: ControllerResult,
  folderIds: readonly string[],
  expandedFolderIds: ReadonlySet<string>,
) {
  const getLayout = () => computeLayout(folderIds, expandedFolderIds, result.current.containers);
  const lastRowOf = (folderId: string): DOMRect => {
    const layout = getLayout();
    const header = layout.headerRects.get(folderId);
    const childRects = layout.childRectsByFolder.get(folderId);
    const values = childRects ? [...childRects.values()] : [];
    const lastRow = values.length > 0 ? values[values.length - 1] : header;
    if (!lastRow) throw new Error(`Missing layout for ${folderId}`);
    return lastRow;
  };
  for (const folderId of folderIds) {
    act(() => {
      result.current.registerRowNode(folderId)({
        getBoundingClientRect: () => {
          const header = getLayout().headerRects.get(folderId);
          if (!header) throw new Error(`Missing header for ${folderId}`);
          return rect(header.top, lastRowOf(folderId).bottom);
        },
        closest: () => null,
        firstElementChild: { getBoundingClientRect: () => getLayout().headerRects.get(folderId) },
        lastElementChild: { getBoundingClientRect: () => lastRowOf(folderId) },
      } as unknown as HTMLElement);
    });
  }
}

function stepDrag(
  result: ControllerResult,
  active: Active,
  folderIds: readonly string[],
  expandedFolderIds: ReadonlySet<string>,
  top: number,
) {
  const layout = computeLayout(folderIds, expandedFolderIds, result.current.containers);
  const collisionRect = rect(top, top + ROW_H);
  active.rect.current.translated = collisionRect;

  const droppableRects = new Map([[ROOT, rect(10000, 10038)]]);
  const droppableContainers = [{ id: ROOT }];
  for (const folderId of folderIds) {
    const headerRect = layout.headerRects.get(folderId);
    if (!headerRect) throw new Error(`Missing header for ${folderId}`);
    droppableRects.set(folderId, headerRect);
    droppableContainers.push({ id: folderId });
    const childRects = layout.childRectsByFolder.get(folderId);
    if (childRects) {
      for (const [siteId, siteRect] of childRects) {
        droppableRects.set(siteId, siteRect);
        droppableContainers.push({ id: siteId });
      }
    }
  }

  let collisions: ReturnType<SiteDragController['collisionDetection']> = [];
  act(() => {
    window.dispatchEvent(
      new window.PointerEvent('pointermove', { clientX: 50, clientY: top + 19 }),
    );
    collisions = result.current.collisionDetection({
      active,
      collisionRect,
      droppableRects,
      droppableContainers,
      pointerCoordinates: { x: 50, y: top + 19 },
    } as unknown as CollisionArgs);
  });

  const overId = collisions[0]?.id ?? null;
  const overRect = overId == null ? null : (droppableRects.get(String(overId)) ?? collisionRect);
  act(() => {
    result.current.handleDragOver({
      active,
      over: overId == null ? null : { id: overId, rect: overRect },
    } as unknown as DragOverEvent);
  });
  return { overId, containers: result.current.containers };
}

function makeActive(id: string, initialTop: number): Active {
  return {
    id,
    data: { current: { kind: 'site' } },
    rect: { current: { initial: rect(initialTop, initialTop + ROW_H), translated: null } },
  } as unknown as Active;
}

describe("useSiteDragController: holding the pointer still near an open folder's last child", () => {
  test('does not oscillate the folder membership frame to frame', () => {
    const entries: ManagedSite[] = [
      { id: 'open-a', kind: 'folder', parentId: null, name: 'open-a' },
      { id: 'c1', kind: 'site', parentId: 'open-a', name: 'c1' },
      { id: 'c2', kind: 'site', parentId: 'open-a', name: 'c2' },
      { id: 'drag-site', kind: 'site', parentId: null, name: 'drag-site' },
    ];
    const folderIds = ['open-a'];
    const expandedFolderIds = new Set(folderIds);
    const onApplyLayout = () => Promise.resolve({ ok: true });
    const { result } = renderHook(() => useSiteDragController({ entries, onApplyLayout }));
    registerLiveFolderNodes(result, folderIds, expandedFolderIds);

    const active = makeActive('drag-site', 500);
    act(() =>
      result.current.handleDragStart({
        active,
        activatorEvent: new MouseEvent('mousedown', { clientX: 50, clientY: 519 }),
      }),
    );

    let top = 400;
    let landedAfterC2 = false;
    while (top >= 0 && !landedAfterC2) {
      const { overId, containers } = stepDrag(result, active, folderIds, expandedFolderIds, top);
      if (overId === 'c2' && (containers['open-a'] ?? []).at(-1) === 'drag-site')
        landedAfterC2 = true;
      else top -= 1;
    }
    expect(landedAfterC2).toBe(true);

    const snapshots = [];
    for (let i = 0; i < 30; i += 1) {
      const { containers } = stepDrag(result, active, folderIds, expandedFolderIds, top);
      snapshots.push(JSON.stringify(containers['open-a']));
    }

    const distinct = new Set(snapshots);
    expect(distinct.size).toBe(1);
    expect(JSON.parse(snapshots[0] ?? '')).toEqual(['c1', 'c2', 'drag-site']);
  });

  test('does not flap in/out of the folder while crossing its bottom boundary', () => {
    const entries: ManagedSite[] = [
      { id: 'open-a', kind: 'folder', parentId: null, name: 'open-a' },
      { id: 'c1', kind: 'site', parentId: 'open-a', name: 'c1' },
      { id: 'c2', kind: 'site', parentId: 'open-a', name: 'c2' },
      { id: 'r-below', kind: 'site', parentId: null, name: 'r-below' },
      { id: 'drag-site', kind: 'site', parentId: null, name: 'drag-site' },
    ];
    const folderIds = ['open-a'];
    const expandedFolderIds = new Set(folderIds);
    const onApplyLayout = () => Promise.resolve({ ok: true });
    const { result } = renderHook(() => useSiteDragController({ entries, onApplyLayout }));
    registerLiveFolderNodes(result, folderIds, expandedFolderIds);

    const rootLayout = () => {
      const folderLayout = computeLayout(folderIds, expandedFolderIds, result.current.containers);
      const rootIds = result.current.containers[ROOT];
      const rootRects = new Map<string, DOMRect>();
      let cursor = folderLayout.bottom;
      for (const id of rootIds) {
        cursor += GAP;
        rootRects.set(id, rect(cursor, cursor + ROW_H));
        cursor += ROW_H;
      }
      return { folderLayout, rootRects, rootZone: rect(folderLayout.bottom, cursor) };
    };

    const stepRealisticDrag = (active: Active, top: number) => {
      const { folderLayout, rootRects, rootZone } = rootLayout();
      const collisionRect = rect(top, top + ROW_H);
      active.rect.current.translated = collisionRect;

      const droppableRects = new Map([[ROOT, rootZone]]);
      const droppableContainers = [{ id: ROOT }];
      for (const [id, r] of rootRects) {
        if (id === active.id) continue;
        droppableRects.set(id, r);
        droppableContainers.push({ id });
      }
      for (const folderId of folderIds) {
        const headerRect = folderLayout.headerRects.get(folderId);
        if (!headerRect) throw new Error(`Missing header for ${folderId}`);
        droppableRects.set(folderId, headerRect);
        droppableContainers.push({ id: folderId });
        const childRects = folderLayout.childRectsByFolder.get(folderId);
        if (childRects) {
          for (const [siteId, siteRect] of childRects) {
            droppableRects.set(siteId, siteRect);
            droppableContainers.push({ id: siteId });
          }
        }
      }

      let collisions: ReturnType<SiteDragController['collisionDetection']> = [];
      act(() => {
        window.dispatchEvent(
          new window.PointerEvent('pointermove', { clientX: 50, clientY: top + 19 }),
        );
        collisions = result.current.collisionDetection({
          active,
          collisionRect,
          droppableRects,
          droppableContainers,
          pointerCoordinates: { x: 50, y: top + 19 },
        } as unknown as CollisionArgs);
      });
      const overId = collisions[0]?.id ?? null;
      const overRect =
        overId == null ? null : (droppableRects.get(String(overId)) ?? collisionRect);
      act(() => {
        result.current.handleDragOver({
          active,
          over: overId == null ? null : { id: overId, rect: overRect },
        } as unknown as DragOverEvent);
      });
      return { overId, containers: result.current.containers };
    };

    const startRect = rootLayout().rootRects.get('drag-site');
    if (!startRect) throw new Error('Missing drag-site layout');
    const startTop = startRect.top;
    const active = makeActive('drag-site', startTop);
    act(() =>
      result.current.handleDragStart({
        active,
        activatorEvent: new MouseEvent('mousedown', { clientX: 50, clientY: startTop + 19 }),
      }),
    );

    const membership = [];
    for (let top = startTop; top >= -10; top -= 1) {
      const { containers } = stepRealisticDrag(active, top);
      membership.push((containers['open-a'] ?? []).includes('drag-site'));
    }

    let transitions = 0;
    for (let i = 1; i < membership.length; i += 1) {
      if (membership[i] !== membership[i - 1]) transitions += 1;
    }

    // A single clean pass into the folder flips membership exactly once.
    // More than that means it flapped in/out somewhere along the sweep.
    expect(membership[0]).toBe(false);
    expect(membership.at(-1)).toBe(true);
    expect(transitions).toBe(1);
  });
});
