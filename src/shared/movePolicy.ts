import type { PaneKind } from './types.ts';

/** The side of a Move, as far as the policy needs to know it. */
export interface MoveEndpoint {
  kind: PaneKind;
  connectionId: string | null;
}

/**
 * Move is offered only where one backend operation carries it out: a rename
 * or verified move on this computer, or a rename on one server connection.
 * Between the computer and a server, or between two connections, a Move would
 * be a copy followed by a delete that nothing ties to the copied version, so
 * only Copy is offered there, for files and folders and from every entry point.
 */
export function canMoveBetween(source: MoveEndpoint, target: MoveEndpoint): boolean {
  if (source.kind !== target.kind) return false;
  if (source.kind === 'local') return true;
  return source.connectionId !== null && source.connectionId === target.connectionId;
}
