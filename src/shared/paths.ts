// Joins path strings; callers must validate untrusted names separately.
import { hostPlatform, localSeparator } from '../platform/os.ts';

/** Remote paths always use posix-style separators, regardless of protocol. */
export function joinRemotePath(base: string, name: string): string {
  if (base === '/' || base === '') return `/${name}`;
  return `${base.replace(/\/+$/, '')}/${name}`;
}

export function joinLocalPath(base: string, name: string): string {
  const separator = localSeparator();
  return `${base}${base.endsWith(separator) ? '' : separator}${name}`;
}

/** Normalize local comparisons without changing Unix filename characters. */
export function normalizeLocalPath(path: string): string {
  return hostPlatform() === 'windows'
    ? path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    : path.replace(/\/+$/, '');
}

/** Select one root, preferring the deepest match on a segment boundary. */
export function currentLocalRoot(path: string, roots: string[]): string | undefined {
  const current = normalizeLocalPath(path);
  return roots
    .filter((root) => {
      const normalized = normalizeLocalPath(root);
      return current === normalized || current.startsWith(normalized + '/');
    })
    .sort((a, b) => b.length - a.length)[0];
}

export function localPathParts(path: string): string[] {
  return path.split(hostPlatform() === 'windows' ? /[\\/]/ : /\//).filter(Boolean);
}

/** A drop target can be a child name or an absolute breadcrumb path. */
export function dropDestinationPath(
  kind: 'local' | 'remote',
  base: string,
  target?: string | null,
): string {
  if (!target) return base;
  if (kind === 'remote') return target.startsWith('/') ? target : joinRemotePath(base, target);
  const absolute =
    hostPlatform() === 'windows'
      ? /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(target)
      : target.startsWith('/');
  return absolute ? target : joinLocalPath(base, target);
}
