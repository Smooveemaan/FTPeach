export const FILE_LIST_SCALE_MIN = 80;
export const FILE_LIST_SCALE_MAX = 160;
export const FILE_LIST_SCALE_DEFAULT = 100;
export const FILE_LIST_SCALE_STEP = 10;
export const FILE_LIST_SCALE_OPTIONS = [80, 90, 100, 110, 120, 130, 140, 150, 160] as const;

export const TERMINAL_FONT_SIZE_MIN = 9;
export const TERMINAL_FONT_SIZE_MAX = 24;
export const TERMINAL_FONT_SIZE_DEFAULT = 12;
export const TERMINAL_FONT_SIZE_STEP = 1;
export const TERMINAL_FONT_SIZE_OPTIONS = [
  9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
] as const;

export function clampFileListScale(value: number): number {
  if (!Number.isFinite(value)) return FILE_LIST_SCALE_DEFAULT;
  return Math.min(FILE_LIST_SCALE_MAX, Math.max(FILE_LIST_SCALE_MIN, Math.round(value)));
}

export function clampTerminalFontSize(value: number): number {
  if (!Number.isFinite(value)) return TERMINAL_FONT_SIZE_DEFAULT;
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(value)));
}

export function stepFileListScale(current: number, direction: 1 | -1): number {
  return clampFileListScale(current + direction * FILE_LIST_SCALE_STEP);
}

export function stepTerminalFontSize(current: number, direction: 1 | -1): number {
  return clampTerminalFontSize(current + direction * TERMINAL_FONT_SIZE_STEP);
}

export function fileListIconMetrics(fileListScale: number): {
  iconSize: number;
  iconTrackWidth: number;
} {
  const iconSize = Math.round((13 * fileListScale) / 100);
  // Keeps the 100% baseline: 13px icon inside a 20px grid track.
  return { iconSize, iconTrackWidth: iconSize + 7 };
}
