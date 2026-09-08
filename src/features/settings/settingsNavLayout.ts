export interface SettingsNavLayout {
  start: number;
  end: number;
  width: number | null;
  offset: number;
  overflowing: boolean;
  canScrollBack: boolean;
  canScrollForward: boolean;
}

export const emptySettingsNavLayout: SettingsNavLayout = {
  start: 0,
  end: -1,
  width: null,
  offset: 0,
  overflowing: false,
  canScrollBack: false,
  canScrollForward: false,
};

/** Logical item order works identically in LTR and RTL. Keep fractional widths. */
export function calculateSettingsNavLayout(
  widths: readonly number[],
  availableWidth: number,
  requestedStart: number,
  revealIndex?: number,
): SettingsNavLayout {
  if (!widths.length || availableWidth <= 0) return emptySettingsNavLayout;
  const positions = [0];
  let totalWidth = 0;
  for (const width of widths) {
    totalWidth += width;
    positions.push(totalWidth);
  }
  const span = (start: number, end: number) => (positions[end + 1] ?? 0) - (positions[start] ?? 0);
  const last = widths.length - 1;
  // Pack the final page so resize cannot leave an avoidable empty tail.
  let maxStart = last;
  while (maxStart > 0 && span(maxStart - 1, last) <= availableWidth) maxStart -= 1;
  let start = Math.max(0, Math.min(maxStart, requestedStart));
  if (revealIndex !== undefined && revealIndex >= 0 && revealIndex <= last) {
    if (revealIndex < start) start = revealIndex;
    while (start < revealIndex && span(start, revealIndex) > availableWidth) start += 1;
    start = Math.min(start, maxStart);
  }
  let end = start;
  while (end < last && span(start, end + 1) <= availableWidth) end += 1;
  return {
    start,
    end,
    width: Math.min(availableWidth, span(start, end)),
    offset: positions[start] ?? 0,
    overflowing: totalWidth > availableWidth,
    canScrollBack: start > 0,
    canScrollForward: end < last,
  };
}
