import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { DragEndEvent, DragOverEvent, DragStartEvent, UniqueIdentifier } from '@dnd-kit/core';

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
  rootRects: Map<string, DOMRect>;
  rootZone: DOMRect;
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
  collapsedRowId: string | null = null,
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
        if (id === collapsedRowId) continue;
        cursor += GAP;
        const childRect = rect(cursor, cursor + ROW_H);
        childRects.set(id, childRect);
        cursor = childRect.bottom;
      }
      childRectsByFolder.set(folderId, childRects);
    }
    cursor += GAP;
  }
  // The ROOT zone follows the folders, as in the real tree.
  const rootTop = cursor;
  const rootRects = new Map<string, DOMRect>();
  for (const id of containers[ROOT]) {
    if (id === collapsedRowId) continue;
    const rootRect = rect(cursor, cursor + ROW_H);
    rootRects.set(id, rootRect);
    cursor = rootRect.bottom + GAP;
  }
  const rootZone = rect(rootTop, Math.max(cursor, rootTop + 24));
  return { headerRects, childRectsByFolder, rootRects, rootZone, bottom: rootZone.bottom };
}

// The row currently pulled out of flow, if any (see computeLayout above).
function collapsedRowIdFor(result: ControllerResult): string | null {
  return result.current.dropTargetFolderId && result.current.canCollapseSource
    ? result.current.activeId
    : null;
}

function registerLiveFolderNodes(
  result: ControllerResult,
  folderIds: readonly string[],
  expandedFolderIds: ReadonlySet<string>,
) {
  const getLayout = () =>
    computeLayout(
      folderIds,
      expandedFolderIds,
      result.current.containers,
      collapsedRowIdFor(result),
    );
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
        firstElementChild: {
          getBoundingClientRect: () => getLayout().headerRects.get(folderId),
        },
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
  const layout = computeLayout(
    folderIds,
    expandedFolderIds,
    result.current.containers,
    collapsedRowIdFor(result),
  );
  const collisionRect = rect(top, top + ROW_H);
  active.rect.current.translated = collisionRect;

  // Every rendered row is a droppable, the dragged one included: dnd-kit keeps
  // the active row's own placeholder in the collision set.
  const droppableRects = new Map([[ROOT, layout.rootZone]]);
  const droppableContainers = [{ id: ROOT }];
  for (const [siteId, siteRect] of layout.rootRects) {
    droppableRects.set(siteId, siteRect);
    droppableContainers.push({ id: siteId });
  }
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
  return { overId, overRect };
}

function makeActive(id: string, initialTop: number): Active {
  return {
    id,
    data: { current: { kind: 'site' } },
    rect: { current: { initial: rect(initialTop, initialTop + ROW_H), translated: null } },
  } as unknown as Active;
}

function dragStartEvent(active: Active, clientY: number): DragStartEvent {
  return {
    active,
    activatorEvent: new MouseEvent('mousedown', { clientX: 50, clientY }),
  } as DragStartEvent;
}

function dragEndEvent(
  active: Active,
  id: UniqueIdentifier | null,
  targetRect: DOMRect | null,
): DragEndEvent {
  return {
    active,
    over: id == null || targetRect == null ? null : { id, rect: targetRect },
  } as unknown as DragEndEvent;
}

function requiredRect(rectValue: DOMRect | undefined, id: string): DOMRect {
  if (!rectValue) throw new Error(`Missing rect for ${id}`);
  return rectValue;
}

const entries: ManagedSite[] = [
  { id: 'closed-top', kind: 'folder', parentId: null, name: 'closed-top' },
  { id: 'open-first', kind: 'folder', parentId: null, name: 'open-first' },
  { id: 'a1', kind: 'site', parentId: 'open-first', name: 'a1' },
  { id: 'a2', kind: 'site', parentId: 'open-first', name: 'a2' },
  { id: 'closed-mid', kind: 'folder', parentId: null, name: 'closed-mid' },
  { id: 'open-second', kind: 'folder', parentId: null, name: 'open-second' },
  { id: 'b1', kind: 'site', parentId: 'open-second', name: 'b1' },
  { id: 'open-empty', kind: 'folder', parentId: null, name: 'open-empty' },
  { id: 'drag-site', kind: 'site', parentId: null, name: 'drag-site' },
];
const folderIds = ['closed-top', 'open-first', 'closed-mid', 'open-second', 'open-empty'];
const expandedFolderIds = new Set(['open-first', 'open-second', 'open-empty']);

function setup() {
  const onApplyLayout = () => Promise.resolve({ ok: true });
  const { result } = renderHook(() => useSiteDragController({ entries, onApplyLayout }));
  registerLiveFolderNodes(result, folderIds, expandedFolderIds);
  return result;
}

describe('useSiteDragController: dragging a bookmark across every folder arrangement', () => {
  test.each([
    ['closed-top', 'closed folder at the top of the list'],
    ['open-first', 'open folder right below a closed one'],
    ['closed-mid', 'closed folder sandwiched between two open folders'],
    ['open-second', 'open folder right below a closed one, with one child'],
    ['open-empty', 'empty open folder at the bottom of the list'],
  ])('hovering %s (%s) highlights it and does not live-project the site', (folderId) => {
    const result = setup();
    const active = makeActive('drag-site', 2000);
    act(() => result.current.handleDragStart(dragStartEvent(active, 2019)));

    const layout = computeLayout(folderIds, expandedFolderIds, result.current.containers);
    const header = requiredRect(layout.headerRects.get(folderId), folderId);
    const before = JSON.stringify(result.current.containers);

    const { overId } = stepDrag(result, active, folderIds, expandedFolderIds, header.top);

    expect(overId).toBe(folderId);
    expect(result.current.dropTargetFolderId).toBe(folderId);
    // Highlight only: no child array anywhere changed while merely hovering
    // a folder's own header, open or closed alike.
    expect(JSON.stringify(result.current.containers)).toBe(before);
  });

  test.each([['closed-top'], ['open-first'], ['closed-mid'], ['open-second'], ['open-empty']])(
    'dropping while %s is highlighted appends the site to the end of its list',
    (folderId) => {
      const result = setup();
      const active = makeActive('drag-site', 2000);
      act(() => result.current.handleDragStart(dragStartEvent(active, 2019)));

      const layout = computeLayout(folderIds, expandedFolderIds, result.current.containers);
      const header = requiredRect(layout.headerRects.get(folderId), folderId);
      stepDrag(result, active, folderIds, expandedFolderIds, header.top);

      const before = result.current.containers[folderId] || [];
      act(() => {
        result.current.handleDragEnd(dragEndEvent(active, folderId, header));
      });

      expect(result.current.containers[folderId]).toEqual([...before, 'drag-site']);
    },
  );

  test('dragging down into an open folder still allows precise positioning among its children', () => {
    const result = setup();
    const active = makeActive('drag-site', 2000);
    act(() => result.current.handleDragStart(dragStartEvent(active, 2019)));

    for (let top = 0; top <= 100; top += 2) {
      stepDrag(result, active, folderIds, expandedFolderIds, top);
    }

    expect(result.current.containers['open-first']).toContain('drag-site');
    expect(result.current.containers['open-first']).not.toEqual(['a1', 'a2']);
  });

  test.each([
    ['downward', 0, 400, 1],
    ['upward', 400, 0, -1],
  ])('a full %s sweep never loses or duplicates any site', (_direction, from, to, step) => {
    const result = setup();
    const active = makeActive('drag-site', from + (step > 0 ? -2000 : 2000));
    act(() => result.current.handleDragStart(dragStartEvent(active, from + 19)));

    for (let top = from; step > 0 ? top <= to : top >= to; top += step) {
      stepDrag(result, active, folderIds, expandedFolderIds, top);
    }

    const allSiteIds = entries.filter((e) => e.kind === 'site').map((e) => e.id);
    const placed = [
      ...result.current.containers[ROOT],
      ...folderIds.flatMap((id) => result.current.containers[id] || []),
    ];
    expect([...placed].sort()).toEqual([...allSiteIds].sort());
  });
});

describe('useSiteDragController: all-open and all-closed folder lists', () => {
  function setupUniform(allExpanded: boolean) {
    const uniformEntries: ManagedSite[] = [
      { id: 'f1', kind: 'folder', parentId: null, name: 'f1' },
      { id: 'f1-a', kind: 'site', parentId: 'f1', name: 'f1-a' },
      { id: 'f2', kind: 'folder', parentId: null, name: 'f2' },
      { id: 'f2-a', kind: 'site', parentId: 'f2', name: 'f2-a' },
      { id: 'f3', kind: 'folder', parentId: null, name: 'f3' },
      { id: 'drag-site', kind: 'site', parentId: null, name: 'drag-site' },
    ];
    const uniformFolderIds = ['f1', 'f2', 'f3'];
    const expanded = new Set(allExpanded ? uniformFolderIds : []);
    const onApplyLayout = () => Promise.resolve({ ok: true });
    const { result } = renderHook(() =>
      useSiteDragController({
        entries: uniformEntries,
        onApplyLayout,
      }),
    );
    registerLiveFolderNodes(result, uniformFolderIds, expanded);
    return { result, uniformFolderIds, expanded };
  }

  test.each([
    [true, 'all folders open'],
    [false, 'all folders closed'],
  ])('every folder highlights on hover and appends on drop when %s (%s)', (allExpanded) => {
    const { result, uniformFolderIds, expanded } = setupUniform(allExpanded);
    const active = makeActive('drag-site', 2000);
    act(() => result.current.handleDragStart(dragStartEvent(active, 2019)));

    for (const folderId of uniformFolderIds) {
      const layout = computeLayout(uniformFolderIds, expanded, result.current.containers);
      const header = requiredRect(layout.headerRects.get(folderId), folderId);
      const before = JSON.stringify(result.current.containers);

      const { overId } = stepDrag(result, active, uniformFolderIds, expanded, header.top);
      expect(overId).toBe(folderId);
      expect(JSON.stringify(result.current.containers)).toBe(before);

      const previousChildren = result.current.containers[folderId] || [];
      act(() => {
        result.current.handleDragEnd(dragEndEvent(active, folderId, header));
      });
      expect(result.current.containers[folderId]).toEqual([...previousChildren, 'drag-site']);

      // Re-start a fresh drag for the next folder in this same list.
      act(() => result.current.handleDragStart(dragStartEvent(active, 2019)));
    }
  });
});

describe('useSiteDragController: reaching the exact end of an open folder', () => {
  test('dragging down past the last child lands after it instead of jumping into the folder below', () => {
    const entries: ManagedSite[] = [
      { id: 'open-a', kind: 'folder', parentId: null, name: 'open-a' },
      { id: 'c1', kind: 'site', parentId: 'open-a', name: 'c1' },
      { id: 'c2', kind: 'site', parentId: 'open-a', name: 'c2' },
      { id: 'open-b', kind: 'folder', parentId: null, name: 'open-b' },
      { id: 'd1', kind: 'site', parentId: 'open-b', name: 'd1' },
      { id: 'drag-site', kind: 'site', parentId: null, name: 'drag-site' },
    ];
    const folderIds = ['open-a', 'open-b'];
    const expandedFolderIds = new Set(folderIds);
    const onApplyLayout = () => Promise.resolve({ ok: true });
    const { result } = renderHook(() => useSiteDragController({ entries, onApplyLayout }));
    registerLiveFolderNodes(result, folderIds, expandedFolderIds);

    const active = makeActive('drag-site', 2000);
    act(() => result.current.handleDragStart(dragStartEvent(active, 2019)));

    // Walk down through open-a's header and both children, stopping well
    // past c2 but nowhere near open-b's own header.
    let overId: UniqueIdentifier | null = null;
    let overRect: DOMRect | null = null;
    for (let top = 0; top <= 130; top += 1) {
      ({ overId, overRect } = stepDrag(result, active, folderIds, expandedFolderIds, top));
    }
    expect(overId).toBe('c2');

    act(() => {
      result.current.handleDragEnd(dragEndEvent(active, overId, overRect));
    });

    expect(result.current.containers['open-a']).toEqual(['c1', 'c2', 'drag-site']);
    expect(result.current.containers['open-b']).toEqual(['d1']);
  });

  test('dragging up from below lands after the last child instead of second-to-last', () => {
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
    act(() => result.current.handleDragStart(dragStartEvent(active, 519)));

    // Walk up from below until the site is projected into the folder (after
    // c2), then settle where its own placeholder, not c2, is under it: that
    // is where the animation shows it as the last child.
    let overId: UniqueIdentifier | null = null;
    let overRect: DOMRect | null = null;
    let top = 400;
    while (!result.current.containers['open-a']?.includes('drag-site') && top > 0) {
      ({ overId, overRect } = stepDrag(result, active, folderIds, expandedFolderIds, top));
      top -= 1;
    }
    expect(result.current.containers['open-a']).toEqual(['c1', 'c2', 'drag-site']);
    while (overId !== 'drag-site' && top < 400) {
      top += 1;
      ({ overId, overRect } = stepDrag(result, active, folderIds, expandedFolderIds, top));
    }
    expect(overId).toBe('drag-site');

    act(() => {
      result.current.handleDragEnd(dragEndEvent(active, overId, overRect));
    });

    expect(result.current.containers['open-a']).toEqual(['c1', 'c2', 'drag-site']);
  });

  test('after moving into a folder, a drop over c2 lands above it, where the animation shows it', () => {
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

    const active = makeActive('drag-site', 120);
    act(() => result.current.handleDragStart(dragStartEvent(active, 139)));

    let overId: UniqueIdentifier | null = null;
    let overRect: DOMRect | null = null;
    let top = 120;
    while (!result.current.containers['open-a']?.includes('drag-site') && top > 0) {
      ({ overId, overRect } = stepDrag(result, active, folderIds, expandedFolderIds, top));
      top -= 1;
    }
    expect(overId).toBe('c2');

    act(() => {
      result.current.handleDragEnd(dragEndEvent(active, overId, overRect));
    });

    expect(result.current.containers['open-a']).toEqual(['c1', 'drag-site', 'c2']);
  });
});

describe('useSiteDragController: the bottom edge of a scrolled list', () => {
  const rootEntries: ManagedSite[] = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
    id: `site-${id}`,
    kind: 'site',
    parentId: null,
    name: id,
  }));

  // A 200px-tall list; the pointer sits in its bottom edge zone over site-c.
  function dropInBottomEdge(rootZone: DOMRect) {
    const onApplyLayout = () => Promise.resolve({ ok: true });
    const { result } = renderHook(() =>
      useSiteDragController({ entries: rootEntries, onApplyLayout }),
    );
    const list = {
      getBoundingClientRect: () => rect(0, 200),
      querySelector: () => ({ getBoundingClientRect: () => rootZone }),
      scrollHeight: rootZone.height,
      clientHeight: 200,
      scrollTop: 0,
    };
    act(() => {
      result.current.registerRowNode('site-a')({
        getBoundingClientRect: () => rect(0, 38),
        closest: () => list,
      } as unknown as HTMLElement);
    });
    const active = makeActive('site-a', 0);
    act(() => result.current.handleDragStart(dragStartEvent(active, 19)));
    act(() => {
      window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 50, clientY: 190 }));
    });
    active.rect.current.translated = rect(120, 158);
    act(() => {
      result.current.handleDragEnd(dragEndEvent(active, 'site-c', rect(80, 118)));
    });
    return result.current.containers[ROOT];
  }

  test('mid-scroll, a drop there lands on the row under the pointer, not past unseen rows', () => {
    expect(dropInBottomEdge(rect(0, 400))).toEqual([
      'site-b',
      'site-c',
      'site-a',
      'site-d',
      'site-e',
    ]);
  });

  test('once the end of the list is on screen, a drop there lands at the very end', () => {
    expect(dropInBottomEdge(rect(0, 200))).toEqual([
      'site-b',
      'site-c',
      'site-d',
      'site-e',
      'site-a',
    ]);
  });
});

describe('useSiteDragController: dragging a bookmark out of its own open folder', () => {
  test('moving down past the next folder highlights it, not the one after', () => {
    const entries: ManagedSite[] = [
      { id: 'open-a', kind: 'folder', parentId: null, name: 'open-a' },
      { id: 's1', kind: 'site', parentId: 'open-a', name: 's1' },
      { id: 's2', kind: 'site', parentId: 'open-a', name: 's2' },
      { id: 'closed-b', kind: 'folder', parentId: null, name: 'closed-b' },
      { id: 'closed-c', kind: 'folder', parentId: null, name: 'closed-c' },
      { id: 'd1', kind: 'site', parentId: 'closed-c', name: 'd1' },
    ];
    const folderIds = ['open-a', 'closed-b', 'closed-c'];
    const expandedFolderIds = new Set(['open-a']);
    const onApplyLayout = () => Promise.resolve({ ok: true });
    const { result } = renderHook(() => useSiteDragController({ entries, onApplyLayout }));
    registerLiveFolderNodes(result, folderIds, expandedFolderIds);

    const active = makeActive('s1', 38);
    act(() => result.current.handleDragStart(dragStartEvent(active, 57)));

    let overId;
    const seen = [];
    for (let top = 38; top <= 160; top += 2) {
      ({ overId } = stepDrag(result, active, folderIds, expandedFolderIds, top));
      seen.push(overId);
    }

    expect(seen).toContain('closed-b');
    expect(result.current.containers['__folders__']).toEqual(['open-a', 'closed-b', 'closed-c']);
    // Once genuinely past closed-b's own header, the drag must keep landing
    // on it rather than flipping straight to closed-c.
    const lastClosedBIndex = seen.lastIndexOf('closed-b');
    const firstClosedCIndex = seen.indexOf('closed-c');
    expect(firstClosedCIndex === -1 || firstClosedCIndex > lastClosedBIndex).toBe(true);
  });
});

describe('useSiteDragController: a folder squeezed between two real rows stays comfortably reachable', () => {
  test('closed-mid has a comfortable (not hairline) window to be the drop target', () => {
    const result = setup();
    const active = makeActive('drag-site', 2000);
    act(() => result.current.handleDragStart(dragStartEvent(active, 2019)));

    let firstHit = null;
    let lastHit = null;
    for (let top = 0; top <= 250; top += 1) {
      const { overId } = stepDrag(result, active, folderIds, expandedFolderIds, top);
      if (overId === 'closed-mid') {
        if (firstHit == null) firstHit = top;
        lastHit = top;
      }
    }

    expect(firstHit).not.toBeNull();
    if (lastHit == null || firstHit == null) throw new Error('Expected closed-mid collision range');
    expect(lastHit - firstHit + 1).toBeGreaterThan(20);
  });
});

describe('useSiteDragController: reordering bookmarks within one list', () => {
  const rootEntries: ManagedSite[] = [
    { id: 'site-a', kind: 'site', parentId: null, name: 'Alpha' },
    { id: 'site-b', kind: 'site', parentId: null, name: 'Beta' },
    { id: 'site-c', kind: 'site', parentId: null, name: 'Gamma' },
  ];

  // The sortable animation swaps rows as soon as `over` changes, which happens
  // well before the dragged row's centre passes the neighbour's centre.
  test.each([
    ['down', 'site-a', 0, 22, 'site-b', ['site-b', 'site-a', 'site-c']],
    ['up', 'site-c', 80, 58, 'site-b', ['site-a', 'site-c', 'site-b']],
  ])(
    'dropping %s just past half a row lands where the animation showed it',
    (_direction, activeId, initialTop, droppedTop, overId, expected) => {
      const onApplyLayout = () => Promise.resolve({ ok: true });
      const { result } = renderHook(() =>
        useSiteDragController({ entries: rootEntries, onApplyLayout }),
      );
      const active = makeActive(activeId, initialTop);
      active.rect.current.translated = rect(droppedTop, droppedTop + ROW_H);

      act(() => {
        result.current.handleDragStart(dragStartEvent(active, initialTop + 19));
        result.current.handleDragEnd(dragEndEvent(active, overId, rect(40, 78)));
      });

      expect(result.current.containers[ROOT]).toEqual(expected);
    },
  );
});

describe('useSiteDragController: layout saves in flight', () => {
  const rootEntries: ManagedSite[] = ['a', 'b', 'c'].map((id) => ({
    id: `site-${id}`,
    kind: 'site',
    parentId: null,
    name: id,
  }));
  type LayoutResult = { ok: boolean; error?: string };

  function deferredApply() {
    const pending: ((_result: LayoutResult) => void)[] = [];
    const onApplyLayout = vi.fn(
      () => new Promise<LayoutResult>((resolve) => pending.push(resolve)),
    );
    return { onApplyLayout, pending };
  }

  test('rapid moves save one at a time and skip an order a newer one replaces', async () => {
    const { onApplyLayout, pending } = deferredApply();
    const { result } = renderHook(() =>
      useSiteDragController({ entries: rootEntries, onApplyLayout }),
    );

    act(() => void result.current.moveEntryBy('site-a', 'site', 1));
    await waitFor(() => expect(onApplyLayout).toHaveBeenCalledTimes(1));
    act(() => void result.current.moveEntryBy('site-a', 'site', 1));
    act(() => void result.current.moveEntryBy('site-c', 'site', -1));
    act(() => void result.current.moveEntryBy('site-c', 'site', 1));
    expect(result.current.containers[ROOT]).toEqual(['site-b', 'site-c', 'site-a']);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onApplyLayout).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending[0]?.({ ok: true });
      await Promise.resolve();
    });
    await waitFor(() => expect(onApplyLayout).toHaveBeenCalledTimes(2));
    expect(onApplyLayout).toHaveBeenLastCalledWith([
      { id: 'site-b', parentId: null },
      { id: 'site-c', parentId: null },
      { id: 'site-a', parentId: null },
    ]);
    await act(async () => {
      pending[1]?.({ ok: true });
      await Promise.resolve();
    });
    expect(onApplyLayout).toHaveBeenCalledTimes(2);
    expect(result.current.containers[ROOT]).toEqual(['site-b', 'site-c', 'site-a']);
  });

  test('a failed save rolls back to the last saved order, not the one before it', async () => {
    const { onApplyLayout, pending } = deferredApply();
    const onCommitError = vi.fn();
    const { result } = renderHook(() =>
      useSiteDragController({ entries: rootEntries, onApplyLayout, onCommitError }),
    );

    act(() => void result.current.moveEntryBy('site-a', 'site', 1));
    await waitFor(() => expect(onApplyLayout).toHaveBeenCalledTimes(1));
    await act(async () => {
      pending[0]?.({ ok: true });
      await Promise.resolve();
    });
    act(() => void result.current.moveEntryBy('site-a', 'site', 1));
    await waitFor(() => expect(onApplyLayout).toHaveBeenCalledTimes(2));
    await act(async () => {
      pending[1]?.({ ok: false, error: 'Layout failed' });
      await Promise.resolve();
    });

    await waitFor(() => expect(onCommitError).toHaveBeenCalledWith('Layout failed'));
    expect(result.current.containers[ROOT]).toEqual(['site-b', 'site-a', 'site-c']);
  });

  test('a list refreshed mid-drag is applied once the drag ends', () => {
    const onApplyLayout = () => Promise.resolve({ ok: true });
    const { result, rerender } = renderHook(
      ({ entries }) => useSiteDragController({ entries, onApplyLayout }),
      { initialProps: { entries: rootEntries } },
    );
    const refreshed: ManagedSite[] = [
      ...rootEntries,
      { id: 'site-d', kind: 'site', parentId: null, name: 'd' },
    ];

    act(() => result.current.handleDragStart(dragStartEvent(makeActive('site-a', 0), 19)));
    rerender({ entries: refreshed });
    expect(result.current.containers[ROOT]).toEqual(['site-a', 'site-b', 'site-c']);

    act(() => result.current.handleDragCancel());
    expect(result.current.containers[ROOT]).toEqual(['site-a', 'site-b', 'site-c', 'site-d']);
  });

  test('a list refreshed while a save is in flight is applied once it settles', async () => {
    const { onApplyLayout, pending } = deferredApply();
    const { result, rerender } = renderHook(
      ({ entries }) => useSiteDragController({ entries, onApplyLayout }),
      { initialProps: { entries: rootEntries } },
    );

    act(() => void result.current.moveEntryBy('site-a', 'site', 1));
    await waitFor(() => expect(onApplyLayout).toHaveBeenCalledTimes(1));
    const refreshed: ManagedSite[] = [
      rootEntries[1]!,
      rootEntries[0]!,
      rootEntries[2]!,
      { id: 'site-d', kind: 'site', parentId: null, name: 'd' },
    ];
    rerender({ entries: refreshed });
    expect(result.current.containers[ROOT]).toEqual(['site-b', 'site-a', 'site-c']);

    await act(async () => {
      pending[0]?.({ ok: true });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(result.current.containers[ROOT]).toEqual(['site-b', 'site-a', 'site-c', 'site-d']),
    );
  });
});

describe('useSiteDragController: failed persistence', () => {
  test('rolls a completed drag back to the persisted order and reports the error', async () => {
    const persistedEntries: ManagedSite[] = [
      { id: 'site-a', kind: 'site', parentId: null, name: 'Alpha' },
      { id: 'site-b', kind: 'site', parentId: null, name: 'Beta' },
    ];
    const onApplyLayout = vi.fn(async () => ({ ok: false, error: 'Layout failed' }));
    const onCommitError = vi.fn();
    const { result } = renderHook(() =>
      useSiteDragController({
        entries: persistedEntries,
        onApplyLayout,
        onCommitError,
      }),
    );
    const active = makeActive('site-a', 0);
    active.rect.current.translated = rect(60, 98);

    act(() => {
      result.current.handleDragStart(dragStartEvent(active, 19));
      result.current.handleDragEnd(dragEndEvent(active, 'site-b', rect(40, 78)));
    });

    await waitFor(() => expect(onCommitError).toHaveBeenCalledWith('Layout failed'));
    expect(onApplyLayout).toHaveBeenCalledWith([
      { id: 'site-b', parentId: null },
      { id: 'site-a', parentId: null },
    ]);
    expect(result.current.containers[ROOT]).toEqual(['site-a', 'site-b']);
    expect(result.current.localEntries.map((entry) => entry.id)).toEqual(['site-a', 'site-b']);
  });
});
