import type {
  ClientRect,
  CollisionDetection,
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
  Modifier,
  SensorDescriptor,
  SensorOptions,
  UniqueIdentifier,
} from '@dnd-kit/core';
import {
  closestCenter,
  getFirstCollision,
  KeyboardCode,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { SiteLayout, SiteMutationResult } from '../../platform/api/sites.ts';
import type { ManagedSite, SiteContainers } from '../../shared/types.ts';
import {
  buildSiteContainers,
  findSiteContainer,
  flattenSiteContainers,
  FOLDERS,
  moveSiteRelative,
  moveSiteToContainerEnd,
  ROOT,
  siteContainersMatch,
} from './siteDragModel.ts';

export interface SiteDragControllerOptions {
  entries: readonly ManagedSite[];
  onApplyLayout: (layout: SiteLayout) => Promise<SiteMutationResult | undefined>;
  onCommitError?: (message: string) => void;
}

interface AutoScrollState {
  container: HTMLElement | null;
  frame: number | null;
  maxScrollTop: number;
  pointerX: number | null;
  pointerY: number | null;
  rootEnd: boolean;
}

interface ActiveRectSize {
  width: number;
  height: number;
}

type CollisionArgs = Parameters<CollisionDetection>[0];

const AUTO_SCROLL_EDGE_PX = 48;
const FOLDER_BOUNDARY_COMFORT_PX = 8;

class RowPointerSensor extends PointerSensor {
  static override activators: (typeof PointerSensor)['activators'] = [
    {
      eventName: 'onPointerDown',
      handler: ({ nativeEvent }) =>
        !(nativeEvent.target instanceof Element && nativeEvent.target.closest('button, input')),
    },
  ];
}

const collisionDetectionStrategy: CollisionDetection = (args) => {
  const rectCollisions = rectIntersection(args);
  const intersections = rectCollisions.length > 0 ? rectCollisions : pointerWithin(args);
  const overId = getFirstCollision(intersections, 'id');
  if (overId != null) return intersections;
  return closestCenter(args);
};

const restrictToVerticalAxis: Modifier = ({ transform }) => {
  return { ...transform, x: 0 };
};

function folderBlockCollisions(
  args: CollisionArgs,
  folderIds: string[],
  folderNodes: Map<UniqueIdentifier, HTMLElement>,
) {
  const initialRect = args.active.rect.current.initial;
  const currentRect = args.collisionRect;
  // dnd-kit declares `collisionRect` as always present, but a collision
  // detector can run on the frame before layout has been measured. Kept as a
  // guard against the library rather than trusted from its type.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see above
  if (!initialRect || !currentRect) return [];

  const activeIndex = folderIds.indexOf(String(args.active.id));
  if (activeIndex === -1) return [];

  const deltaY = currentRect.top - initialRect.top;
  if (deltaY === 0) return [];

  if (deltaY > 0) {
    for (let index = folderIds.length - 1; index > activeIndex; index -= 1) {
      const id = folderIds[index];
      if (id === undefined) continue;
      const rect = args.droppableRects.get(id);
      const headerHeight = folderNodes.get(id)?.firstElementChild?.getBoundingClientRect().height;
      if (rect) {
        const threshold = rect.top + (headerHeight ?? rect.height) / 2;
        if (currentRect.bottom >= threshold) return [{ id }];
      }
    }
  } else {
    // Travelling up, use the centre of the target's bottom visible row. This
    // mirrors the downward leading-edge behaviour for an expanded block.
    for (let index = 0; index < activeIndex; index += 1) {
      const id = folderIds[index];
      if (id === undefined) continue;
      const rect = args.droppableRects.get(id);
      const folderNode = folderNodes.get(id);
      const lastChild = folderNode?.lastElementChild;
      const bottomRow = lastChild?.lastElementChild || lastChild;
      const bottomRowHeight = bottomRow?.getBoundingClientRect().height;
      if (rect) {
        const threshold = rect.bottom - (bottomRowHeight ?? rect.height) / 2;
        if (currentRect.top <= threshold) return [{ id }];
      }
    }
  }

  return [];
}

export interface SiteDragControllerModel {
  activeEntry: ManagedSite | null | undefined;
  activeId: string | null;
  activeRect: ActiveRectSize | null;
  canCollapseSource: boolean;
  collisionDetection: CollisionDetection;
  containers: SiteContainers;
  dragContentHeight: number | null;
  dropTargetFolderId: string | null;
  entriesById: Map<string, ManagedSite>;
  handleDragCancel: () => void;
  handleDragEnd: (event: DragEndEvent) => void;
  handleDragOver: (event: DragOverEvent) => void;
  handleDragStart: (event: DragStartEvent) => void;
  localEntries: ManagedSite[];
  modifiers: Modifier[];
  moveEntryBy: (id: string, kind: string | undefined, delta: number) => Promise<void>;
  registerRowNode: (id: UniqueIdentifier) => (node: HTMLElement | null) => void;
  sensors: SensorDescriptor<SensorOptions>[];
  setLocalEntries: Dispatch<SetStateAction<ManagedSite[]>>;
}

export function useSiteDragController({
  entries,
  onApplyLayout,
  onCommitError,
}: SiteDragControllerOptions): SiteDragControllerModel {
  const [localEntries, setLocalEntries] = useState<ManagedSite[]>(() => [...entries]);
  const draggingRef = useRef(false);
  const committingRef = useRef(false);
  const autoScrollRef = useRef<AutoScrollState>({
    container: null,
    frame: null,
    maxScrollTop: 0,
    pointerX: null,
    pointerY: null,
    rootEnd: false,
  });
  const dropTargetFolderRef = useRef<string | null>(null);
  useEffect(() => {
    const trackPointer = (event: PointerEvent) => {
      if (!draggingRef.current) return;
      const state = autoScrollRef.current;
      state.pointerX = event.clientX;
      state.pointerY = event.clientY;
      const bounds = state.container?.getBoundingClientRect();
      const rootBounds = state.container
        ?.querySelector('.site-manage-root-zone')
        ?.getBoundingClientRect();
      state.rootEnd = Boolean(
        bounds &&
        rootBounds &&
        rootBounds.top <= bounds.bottom &&
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.bottom - AUTO_SCROLL_EDGE_PX,
      );
    };
    window.addEventListener('pointermove', trackPointer, true);
    return () => window.removeEventListener('pointermove', trackPointer, true);
  }, []);
  useEffect(
    () => () => {
      if (autoScrollRef.current.frame != null) {
        cancelAnimationFrame(autoScrollRef.current.frame);
      }
    },
    [],
  );
  useEffect(() => {
    if (!draggingRef.current && !committingRef.current) setLocalEntries([...entries]);
  }, [entries]);

  const rowNodesRef = useRef(new Map<UniqueIdentifier, HTMLElement>());
  const rowNodeCallbacksRef = useRef(
    new Map<UniqueIdentifier, (node: HTMLElement | null) => void>(),
  );
  const registerRowNode = (id: UniqueIdentifier) => {
    if (!rowNodeCallbacksRef.current.has(id)) {
      rowNodeCallbacksRef.current.set(id, (node: HTMLElement | null) => {
        if (node) rowNodesRef.current.set(id, node);
        else rowNodesRef.current.delete(id);
      });
    }
    return rowNodeCallbacksRef.current.get(id)!;
  };

  const entriesById = useMemo(
    () => new Map<string, ManagedSite>(localEntries.map((entry) => [entry.id, entry])),
    [localEntries],
  );

  const [containers, setContainers] = useState(() => buildSiteContainers(entries));
  const containersRef = useRef(containers);
  const applyContainers = (
    next: SiteContainers | ((previous: SiteContainers) => SiteContainers),
  ) => {
    setContainers((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      containersRef.current = resolved;
      return resolved;
    });
  };
  useEffect(() => {
    if (!draggingRef.current) applyContainers(buildSiteContainers(localEntries));
  }, [localEntries]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [dropTargetFolderId, setDropTargetFolderId] = useState<string | null>(null);
  const activeEntry = activeId ? entriesById.get(activeId) : null;
  const [activeRect, setActiveRect] = useState<ActiveRectSize | null>(null);
  const [dragContentHeight, setDragContentHeight] = useState<number | null>(null);

  const activeSourceContainer = activeId ? findSiteContainer(activeId, containers) : null;
  const canCollapseSource = activeSourceContainer === ROOT;

  const sensors = useSensors(
    useSensor(RowPointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: {
        start: [KeyboardCode.Space],
        cancel: [KeyboardCode.Esc],
        end: [KeyboardCode.Space],
      },
    }),
  );

  const resolveSiteOverContainer = (overId: UniqueIdentifier, cs: SiteContainers) => {
    const id = String(overId);
    if (id === ROOT) return ROOT;
    return findSiteContainer(id, cs) ?? null;
  };

  const resolveFolderDropTarget = (overId: UniqueIdentifier, cs: SiteContainers) => {
    const id = String(overId);
    return cs[FOLDERS].includes(id) ? id : null;
  };

  const collisionDetection: CollisionDetection = (args) => {
    const draggingFolder = args.active.data.current?.kind === 'folder';
    const rootItems = containersRef.current[ROOT];
    const lastRootId = rootItems[rootItems.length - 1];
    const lastRootRect = lastRootId ? args.droppableRects.get(lastRootId) : null;
    const rootRect = args.droppableRects.get(ROOT);
    const pointerY = autoScrollRef.current.pointerY ?? args.pointerCoordinates?.y;
    if (
      !draggingFolder &&
      lastRootId &&
      rootRect &&
      pointerY != null &&
      (autoScrollRef.current.rootEnd ||
        (lastRootRect && pointerY >= lastRootRect.bottom && pointerY <= rootRect.bottom))
    ) {
      return [{ id: lastRootId }];
    }
    if (draggingFolder) {
      return folderBlockCollisions(args, containersRef.current[FOLDERS], rowNodesRef.current);
    }
    const folderIds = containersRef.current[FOLDERS];
    const isRealRow = (id: UniqueIdentifier) => {
      const value = String(id);
      return !folderIds.includes(value) && value !== ROOT;
    };
    const rectsOverlap = (
      a: Pick<ClientRect, 'top' | 'bottom'>,
      b: Pick<ClientRect, 'top' | 'bottom'>,
    ) => a.bottom > b.top && a.top < b.bottom;
    const anyRowOverlap = args.droppableContainers.some((container) => {
      if (!isRealRow(container.id)) return false;
      const rect = args.droppableRects.get(container.id);
      if (!rect) return false;
      const protectedRect = {
        top: rect.top + FOLDER_BOUNDARY_COMFORT_PX,
        bottom: rect.bottom - FOLDER_BOUNDARY_COMFORT_PX,
      };
      return rectsOverlap(args.collisionRect, protectedRect);
    });
    const droppableRects = new Map(args.droppableRects);
    const droppableContainers = args.droppableContainers.filter((container) => {
      if (!folderIds.includes(String(container.id))) return true;
      if (anyRowOverlap) return false;
      const headerBounds = rowNodesRef.current
        .get(container.id)
        ?.firstElementChild?.getBoundingClientRect();
      if (!headerBounds) return true;
      droppableRects.set(container.id, headerBounds);
      return (
        args.collisionRect.bottom >= headerBounds.top &&
        args.collisionRect.top <= headerBounds.bottom
      );
    });
    return collisionDetectionStrategy({ ...args, droppableContainers, droppableRects });
  };

  const handleDragStart = (event: DragStartEvent) => {
    draggingRef.current = true;
    setActiveId(String(event.active.id));
    const node = rowNodesRef.current.get(event.active.id);
    const rect = node?.getBoundingClientRect();
    if (autoScrollRef.current.frame != null) cancelAnimationFrame(autoScrollRef.current.frame);
    const scrollContainer = node?.closest<HTMLElement>('.site-manage-list') ?? null;
    const activatorY =
      event.activatorEvent instanceof MouseEvent ? event.activatorEvent.clientY : undefined;
    const activatorX =
      event.activatorEvent instanceof MouseEvent ? event.activatorEvent.clientX : undefined;
    autoScrollRef.current.container = scrollContainer;
    autoScrollRef.current.maxScrollTop = scrollContainer
      ? Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight)
      : 0;
    autoScrollRef.current.pointerX =
      typeof activatorX === 'number' && Number.isFinite(activatorX) ? activatorX : null;
    autoScrollRef.current.pointerY =
      typeof activatorY === 'number' && Number.isFinite(activatorY) ? activatorY : null;
    autoScrollRef.current.rootEnd = false;
    dropTargetFolderRef.current = null;
    setDropTargetFolderId(null);
    setDragContentHeight(scrollContainer?.scrollHeight ?? null);

    const tickAutoScroll = () => {
      const state = autoScrollRef.current;
      const container = state.container;
      if (!draggingRef.current || !container) {
        state.frame = null;
        return;
      }
      const bounds = container.getBoundingClientRect();
      const edgeSize = Math.min(AUTO_SCROLL_EDGE_PX, bounds.height / 4);
      let speed = 0;
      const pointerInsideX =
        state.pointerX != null && state.pointerX >= bounds.left && state.pointerX <= bounds.right;
      if (pointerInsideX && state.pointerY != null && state.pointerY < bounds.top + edgeSize) {
        speed = -12 * (1 - Math.max(0, state.pointerY - bounds.top) / edgeSize);
      } else if (
        pointerInsideX &&
        state.pointerY != null &&
        state.pointerY > bounds.bottom - edgeSize
      ) {
        speed = 12 * (1 - Math.max(0, bounds.bottom - state.pointerY) / edgeSize);
      }
      if (speed !== 0) {
        const next = Math.max(0, Math.min(state.maxScrollTop, container.scrollTop + speed));
        if (next !== container.scrollTop) container.scrollTop = next;
      }
      state.frame = requestAnimationFrame(tickAutoScroll);
    };
    autoScrollRef.current.frame = requestAnimationFrame(tickAutoScroll);
    setActiveRect(rect ? { width: rect.width, height: rect.height } : null);
  };

  const stopAutoScroll = () => {
    const state = autoScrollRef.current;
    if (state.frame != null) cancelAnimationFrame(state.frame);
    state.container = null;
    state.frame = null;
    state.pointerX = null;
    state.pointerY = null;
    state.rootEnd = false;
    dropTargetFolderRef.current = null;
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) {
      dropTargetFolderRef.current = null;
      setDropTargetFolderId(null);
      return;
    }
    // Compared inline rather than bound to a variable: dnd-kit types the drag
    // payload as `any`, and the comparison keeps that `any` from spreading.
    if (active.data.current?.kind === 'folder') return;

    const targetFolderId = resolveFolderDropTarget(over.id, containersRef.current);
    dropTargetFolderRef.current = targetFolderId;
    setDropTargetFolderId(targetFolderId);
    if (targetFolderId) {
      return;
    }

    applyContainers((current) => {
      const activeId = String(active.id);
      const overId = String(over.id);
      const sourceContainer = findSiteContainer(activeId, current);
      const destinationContainer = resolveSiteOverContainer(over.id, current);
      if (!sourceContainer || !destinationContainer || sourceContainer === destinationContainer) {
        return current;
      }
      const overIndex = current[destinationContainer]?.indexOf(overId) ?? -1;
      const translated = active.rect.current.translated;
      const insertAfter = Boolean(
        overIndex !== -1 &&
        translated &&
        translated.top + translated.height / 2 > over.rect.top + over.rect.height / 2,
      );
      return moveSiteRelative(current, activeId, destinationContainer, overId, insertAfter);
    });
  };

  const commitDrag = async (
    finalContainers: SiteContainers,
    draggedId: string,
    draggedKind: string | undefined,
  ) => {
    const persistedEntries = entries;
    if (siteContainersMatch(finalContainers, buildSiteContainers(persistedEntries))) return;
    committingRef.current = true;
    const originalEntry = entries.find((e) => e.id === draggedId);
    const oldParentId = originalEntry?.parentId || null;
    let newParentId = oldParentId;
    if (draggedKind === 'folder') {
      newParentId = null;
    } else {
      const container = findSiteContainer(draggedId, finalContainers);
      newParentId = container && container !== ROOT ? container : null;
    }
    const orderedIds = flattenSiteContainers(finalContainers);
    const finalEntries = orderedIds
      .map((id) => entriesById.get(id))
      .filter((entry): entry is ManagedSite => entry != null)
      .map((e) => (e.id === draggedId ? { ...e, parentId: newParentId } : e));
    setLocalEntries(finalEntries);
    const layout = finalEntries.map((e) => ({
      id: e.id,
      parentId: e.kind === 'folder' ? null : e.parentId || null,
    }));
    let errorMessage = '';
    try {
      const result = await onApplyLayout(layout);
      if (result?.ok !== false) {
        committingRef.current = false;
        return true;
      }
      errorMessage = result.error || '';
    } catch (cause) {
      errorMessage = cause instanceof Error ? cause.message : '';
    }

    // The renderer owns an optimistic projection only — restore the last
    // persisted snapshot.
    setLocalEntries([...persistedEntries]);
    applyContainers(buildSiteContainers(persistedEntries));
    committingRef.current = false;
    onCommitError?.(errorMessage);
    return false;
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    const cs = containersRef.current;
    const targetFolderId = dropTargetFolderRef.current;
    const dropAtRootEnd = autoScrollRef.current.rootEnd;
    draggingRef.current = false;
    // Capture intent before stopAutoScroll clears it.
    stopAutoScroll();
    const activeKind = active.data.current?.kind === 'folder' ? 'folder' : 'site';
    const finishDrop = (next: SiteContainers, shouldCommit = true) => {
      flushSync(() => {
        applyContainers(next);
        setActiveId(null);
        setDropTargetFolderId(null);
        setDragContentHeight(null);
      });
      if (shouldCommit) void commitDrag(next, String(active.id), activeKind);
    };

    if (activeKind !== 'folder' && dropAtRootEnd) {
      const next = moveSiteToContainerEnd(cs, String(active.id), ROOT);
      finishDrop(next);
      return;
    }

    if (!over) {
      finishDrop(buildSiteContainers(localEntries), false);
      return;
    }

    if (targetFolderId) {
      const activeId = String(active.id);
      const sourceContainer = findSiteContainer(activeId, cs);
      const sourceItems = sourceContainer === undefined ? undefined : cs[sourceContainer];
      if (sourceContainer === undefined || !sourceItems) {
        finishDrop(buildSiteContainers(localEntries), false);
        return;
      }
      const withoutActive = {
        ...cs,
        [sourceContainer]: sourceItems.filter((id) => id !== activeId),
      };
      const next = {
        ...withoutActive,
        [targetFolderId]: [...(withoutActive[targetFolderId] || []), activeId],
      };
      finishDrop(next);
      return;
    }

    if (activeKind !== 'folder') {
      const activeId = String(active.id);
      const overId = String(over.id);
      const sourceContainer = findSiteContainer(activeId, cs);
      const destinationContainer = resolveSiteOverContainer(over.id, cs);
      if (sourceContainer && destinationContainer && overId !== activeId) {
        const overIndex = cs[destinationContainer]?.indexOf(overId) ?? -1;
        const translated = active.rect.current.translated;
        const insertAfter = Boolean(
          overIndex !== -1 &&
          translated &&
          translated.top + translated.height / 2 > over.rect.top + over.rect.height / 2,
        );
        const next = moveSiteRelative(cs, activeId, destinationContainer, overId, insertAfter);
        finishDrop(next);
        return;
      }
    }

    const activeId = String(active.id);
    const overId = String(over.id);
    const containerKey = activeKind === 'folder' ? FOLDERS : findSiteContainer(activeId, cs);
    if (!containerKey) {
      finishDrop(cs);
      return;
    }
    const list = cs[containerKey];
    if (!list) {
      finishDrop(cs);
      return;
    }
    const oldIdx = list.indexOf(activeId);
    const newIdx = list.indexOf(overId);
    const next =
      oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx
        ? { ...cs, [containerKey]: arrayMove(list, oldIdx, newIdx) }
        : cs;
    finishDrop(next);
  };

  const moveEntryBy = async (id: string, kind: string | undefined, delta: number) => {
    const cs = containersRef.current;
    const containerKey = kind === 'folder' ? FOLDERS : findSiteContainer(id, cs);
    if (!containerKey) return;
    const list = cs[containerKey];
    if (!list) return;
    const oldIndex = list.indexOf(id);
    const newIndex = oldIndex + delta;
    if (oldIndex === -1 || newIndex < 0 || newIndex >= list.length) return;
    const next = { ...cs, [containerKey]: arrayMove(list, oldIndex, newIndex) };
    applyContainers(next);
    await commitDrag(next, id, kind);
  };

  const handleDragCancel = () => {
    draggingRef.current = false;
    stopAutoScroll();
    setActiveId(null);
    setDropTargetFolderId(null);
    setDragContentHeight(null);
    applyContainers(buildSiteContainers(localEntries));
  };

  return {
    activeEntry,
    activeId,
    activeRect,
    canCollapseSource,
    collisionDetection,
    containers,
    dragContentHeight,
    dropTargetFolderId,
    entriesById,
    handleDragCancel,
    handleDragEnd,
    handleDragOver,
    handleDragStart,
    localEntries,
    modifiers: [restrictToVerticalAxis],
    moveEntryBy,
    registerRowNode,
    sensors,
    setLocalEntries,
  };
}
