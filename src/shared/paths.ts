// Joins path strings; callers must validate untrusted names separately.

/** Remote paths always use posix-style separators, regardless of protocol. */
export function joinRemotePath(base: string, name: string): string {
  if (base === '/' || base === '') return `/${name}`;
  return `${base.replace(/\/+$/, '')}/${name}`;
}

export function joinLocalPath(base: string, name: string): string {
  return `${base}${base.endsWith('\\') ? '' : '\\'}${name}`;
}

/** A drop target can be a child name or an absolute breadcrumb path. */
export function dropDestinationPath(
  kind: 'local' | 'remote',
  base: string,
  target?: string | null,
): string {
  if (!target) return base;
  if (kind === 'remote') return target.startsWith('/') ? target : joinRemotePath(base, target);
  return /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(target) ? target : joinLocalPath(base, target);
}
