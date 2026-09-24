import { dropDestinationPath } from '../../../shared/paths.ts';
import { canMoveBetween } from '../../../shared/movePolicy.ts';
import { paneJoin } from '../panes/paneBackend.ts';
import type { PaneState } from '../panes/paneModel.ts';

export type DropAction = 'copy' | 'move' | 'invalid' | null;
export interface DropKeys {
  ctrlKey: boolean;
  shiftKey: boolean;
}

export function resolveDropAction(
  source: PaneState,
  target: PaneState,
  folder: string | null,
  names: string[],
  keys: DropKeys,
): DropAction {
  if (keys.ctrlKey && keys.shiftKey) return 'invalid';
  if (!source.path || !target.path || !names.length) return 'invalid';
  if (
    [source, target].some(
      (p) => p.kind === 'remote' && (p.status !== 'connected' || !p.connectionId),
    )
  )
    return 'invalid';
  const same = canMoveBetween(source, target);
  const normalize = (path: string) =>
    source.kind === 'local'
      ? path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      : path.replace(/\/+$/, '');
  const destination = normalize(dropDestinationPath(target.kind, target.path, folder));
  if (same) {
    if (destination === normalize(source.path)) return 'invalid';
    for (const name of names) {
      const entry = source.entries.find((e) => e.name === name);
      if (!entry) return 'invalid';
      const path = normalize(paneJoin(source, name));
      if (destination === path || (entry.isDirectory && destination.startsWith(path + '/')))
        return 'invalid';
    }
  }
  // Like Explorer: with no modifier, a drop onto another disk copies. Shift still moves there.
  // ponytail: drive letter or UNC share only; mount points, subst and junctions count as their host volume
  const volume = (path: string) => /^([a-z]:|\/\/[^/]+\/[^/]+)/.exec(path)?.[1] ?? '';
  const sameVolume =
    source.kind !== 'local' || volume(normalize(source.path)) === volume(destination);
  const move = keys.shiftKey || (!keys.ctrlKey && same && sameVolume);
  return move ? (same ? 'move' : 'invalid') : 'copy';
}
