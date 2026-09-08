// Joins path strings; callers must validate untrusted names separately.

/** Remote paths always use posix-style separators, regardless of protocol. */
export function joinRemotePath(base: string, name: string): string {
  if (base === '/' || base === '') return `/${name}`;
  return `${base.replace(/\/+$/, '')}/${name}`;
}

export function joinLocalPath(base: string, name: string): string {
  return `${base}${base.endsWith('\\') ? '' : '\\'}${name}`;
}
