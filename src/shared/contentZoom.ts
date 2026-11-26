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

/** Gap between wheel events after which a previous scroll/momentum gesture is considered finished. */
export const WHEEL_GESTURE_IDLE_MS = 400;
/** Accumulated pixel delta required per zoom step so trackpad jitter and stray tail ticks do not zoom. */
export const WHEEL_ZOOM_DELTA_THRESHOLD = 40;

export interface WheelZoomState {
  mode: 'scroll' | 'zoom' | null;
  lastEventTime: number;
  accumulatedDeltaY: number;
}

export interface WheelZoomSample {
  timeStamp: number;
  zoomModifier: boolean;
  deltaY: number;
  deltaMode: number;
}

export interface WheelZoomDecision {
  /** Whether the active wheel gesture is a zoom gesture (vs. plain or momentum scroll). */
  zoomGesture: boolean;
  /** Non-null when accumulated wheel delta crossed the step threshold. */
  direction: 1 | -1 | null;
}

export function createWheelZoomState(): WheelZoomState {
  return { mode: null, lastEventTime: -Infinity, accumulatedDeltaY: 0 };
}

/**
 * Classifies a wheel event stream so trackpad/touchpad momentum scrolling that
 * started without the zoom modifier never turns into a zoom when the user
 * presses Cmd/Ctrl before the scroll animation finishes.
 */
export function consumeWheelZoomEvent(
  state: WheelZoomState,
  sample: WheelZoomSample,
): WheelZoomDecision {
  const { timeStamp, zoomModifier, deltaY, deltaMode } = sample;
  if (timeStamp - state.lastEventTime > WHEEL_GESTURE_IDLE_MS) {
    state.mode = null;
    state.accumulatedDeltaY = 0;
  }
  state.lastEventTime = timeStamp;

  if (!zoomModifier) {
    state.mode = 'scroll';
    state.accumulatedDeltaY = 0;
    return { zoomGesture: false, direction: null };
  }

  if (state.mode === null) {
    state.mode = 'zoom';
  }
  if (state.mode !== 'zoom') {
    state.accumulatedDeltaY = 0;
    return { zoomGesture: false, direction: null };
  }

  if (deltaY === 0) {
    return { zoomGesture: true, direction: null };
  }

  // Discrete line/page wheel modes always come from notched wheels, never trackpad inertia.
  if (deltaMode !== 0) {
    state.accumulatedDeltaY = 0;
    return { zoomGesture: true, direction: deltaY < 0 ? 1 : -1 };
  }

  if (state.accumulatedDeltaY !== 0 && Math.sign(deltaY) !== Math.sign(state.accumulatedDeltaY)) {
    state.accumulatedDeltaY = 0;
  }
  state.accumulatedDeltaY += deltaY;

  if (Math.abs(state.accumulatedDeltaY) < WHEEL_ZOOM_DELTA_THRESHOLD) {
    return { zoomGesture: true, direction: null };
  }

  const direction: 1 | -1 = state.accumulatedDeltaY < 0 ? 1 : -1;
  state.accumulatedDeltaY = 0;
  return { zoomGesture: true, direction };
}

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
