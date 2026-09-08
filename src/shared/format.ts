// Human-readable sizes, rates and durations. Localized, but domain-free: a
// byte count reads the same whether it came from a listing or a transfer.

import i18n from '../i18n/index.ts';

const BYTE_UNIT_KEYS = [
  'common.units.kb',
  'common.units.mb',
  'common.units.gb',
  'common.units.tb',
] as const;

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} ${i18n.t('common.units.byte')}`;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNIT_KEYS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${i18n.t(BYTE_UNIT_KEYS[unitIndex]!)}`;
}

export function formatBytesPair(
  bytes: number,
  total: number | null | undefined,
): { current: string; total: string } {
  if (total === null || total === undefined || Number.isNaN(total) || total <= 0) {
    return { current: formatBytes(bytes), total: '' };
  }
  if (total < 1024) {
    const byteUnit = i18n.t('common.units.byte');
    return { current: `${bytes} ${byteUnit}`, total: `${total} ${byteUnit}` };
  }
  let divisor = 1024;
  let unitIndex = 0;
  while (total / divisor >= 1024 && unitIndex < BYTE_UNIT_KEYS.length - 1) {
    divisor *= 1024;
    unitIndex += 1;
  }
  const totalValue = total / divisor;
  const currentValue = bytes / divisor;
  const decimals = totalValue < 10 ? 1 : 0;
  const unit = i18n.t(BYTE_UNIT_KEYS[unitIndex]!);
  return {
    current: `${currentValue.toFixed(decimals)} ${unit}`,
    total: `${totalValue.toFixed(decimals)} ${unit}`,
  };
}

export function formatSpeed(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec === null || bytesPerSec === undefined || !Number.isFinite(bytesPerSec))
    return '—';
  const normalized = Math.max(0, bytesPerSec);
  const value =
    normalized > 0 && normalized < 1
      ? `<1 ${i18n.t('common.units.byte')}`
      : normalized < 1024
        ? `${Math.round(normalized)} ${i18n.t('common.units.byte')}`
        : formatBytes(normalized);
  return i18n.t('common.perSecond', { value });
}

export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) {
    return '—';
  }
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
