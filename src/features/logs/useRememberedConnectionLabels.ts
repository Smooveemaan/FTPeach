import { useEffect, useMemo, useRef } from 'react';

// Kept for the window's lifetime, so a reloaded interface can still name the
// connections in the log history the backend hands back.
const STORAGE_KEY = 'ftpeach.logConnectionLabels';
// Far more connections than a session opens; the oldest go first.
const MAX_REMEMBERED = 200;

function isLabelEntry(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'string'
  );
}

function loadRemembered(): ReadonlyMap<string, string> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]');
    return new Map(Array.isArray(parsed) ? parsed.filter(isLabelEntry) : []);
  } catch {
    return new Map();
  }
}

function saveRemembered(labels: ReadonlyMap<string, string>): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...labels]));
  } catch {
    // Without storage the names last until the next reload, as before.
  }
}

/**
 * Every label a connection has had in this window, so the log can still name
 * a connection after its tab has closed — even when the log panel was closed
 * at the time, since the app holds this and not the panel, and after the
 * interface reloads. The same map comes back until a label is added or changes.
 */
export function useRememberedConnectionLabels(
  labels: ReadonlyMap<string | null, string>,
): ReadonlyMap<string, string> {
  const rememberedRef = useRef<ReadonlyMap<string, string> | null>(null);
  const remembered = useMemo(() => {
    const previous = (rememberedRef.current ??= loadRemembered());
    const changed = [...labels].filter(
      (entry): entry is [string, string] => !!entry[0] && previous.get(entry[0]) !== entry[1],
    );
    if (changed.length === 0) return previous;
    const next = new Map(previous);
    for (const [connectionId, label] of changed) {
      next.delete(connectionId);
      next.set(connectionId, label);
    }
    for (const connectionId of next.keys()) {
      if (next.size <= MAX_REMEMBERED) break;
      next.delete(connectionId);
    }
    rememberedRef.current = next;
    return next;
  }, [labels]);
  useEffect(() => saveRemembered(remembered), [remembered]);
  return remembered;
}
