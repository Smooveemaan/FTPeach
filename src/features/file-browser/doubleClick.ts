// Rows detect double clicks from click timing (see FilePane.tsx), so the
// window follows the Windows double-click speed read at startup.
let doubleClickMs = 500;

export const getDoubleClickMs = (): number => doubleClickMs;

export function setDoubleClickMs(ms: number | null): void {
  if (ms && ms > 0) doubleClickMs = ms;
}
