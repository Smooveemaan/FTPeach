export interface SpeedSample {
  bytes: number;
  time: number;
  speed: number | null;
  /** A byte change has established the measurement baseline. */
  atChange: boolean;
}
export type SpeedSamples = Record<string, SpeedSample>;

/** Seconds without a new byte after which a running transfer reads 0 B/s. */
const STALLED_AFTER = 2;
/** The shortest stretch of time one measurement spans, in seconds. */
const MIN_WINDOW = 0.2;

/**
 * The smoothed speed of a running transfer, or null until it has one.
 *
 * The transfer list calls this on every render, and it renders for any row's
 * progress, the log and much else, so a render on its own says nothing about
 * this transfer. Only a change in its byte count is measured: the speed is
 * what arrived between two moments the count was seen to change.
 */
export function updateSpeedSample(
  samples: SpeedSamples,
  id: string,
  bytes: number,
  status: string,
  now = performance.now(),
): number | null {
  if (status !== 'progress') {
    delete samples[id];
    return null;
  }
  const prev = samples[id];
  if (!prev || bytes < prev.bytes) {
    samples[id] = { bytes, time: now, speed: null, atChange: false };
    return null;
  }
  const dt = (now - prev.time) / 1000;
  if (bytes === prev.bytes) {
    if (dt >= STALLED_AFTER) prev.speed = 0;
    return prev.speed;
  }
  if (dt < MIN_WINDOW) return prev.speed;
  // The first byte change starts the baseline because the initial wait may be setup.
  if (!prev.atChange) {
    const shown = dt >= STALLED_AFTER ? 0 : prev.speed;
    samples[id] = { bytes, time: now, speed: shown, atChange: true };
    return shown;
  }
  const instant = (bytes - prev.bytes) / dt;
  // A 0 only ever comes from a stall, so it is no average to start from.
  const speed = prev.speed ? prev.speed * 0.7 + instant * 0.3 : instant;
  samples[id] = { bytes, time: now, speed, atChange: true };
  return speed;
}
