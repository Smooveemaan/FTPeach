export interface SpeedSample {
  bytes: number;
  time: number;
  speed: number | null;
}
export type SpeedSamples = Record<string, SpeedSample>;

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
    samples[id] = { bytes, time: now, speed: null };
    return null;
  }
  const dt = (now - prev.time) / 1000;
  if (bytes === prev.bytes && dt >= 2) {
    samples[id] = { bytes, time: now, speed: null };
    return 0;
  }
  if (dt < 0.2) return prev.speed;
  const instant = (bytes - prev.bytes) / dt;
  const speed = prev.speed == null ? instant : prev.speed * 0.7 + instant * 0.3;
  samples[id] = { bytes, time: now, speed };
  return speed;
}
