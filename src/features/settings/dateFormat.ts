import { useSyncExternalStore } from 'react';

/**
 * Formats a timestamp for display, already bound to the user's preference.
 *
 * Passing this around instead of calling a global formatter is what lets a
 * column renderer be tested by handing it a formatter, with no ambient state
 * to set up or tear down.
 */
export type DateFormatter = (date: string | number | Date | null | undefined) => string;

/**
 * Builds a formatter for one preference. Pure: same arguments, same output,
 * no module state involved.
 *
 * `hourCycle` only applies to the `locale` preference — the explicit patterns
 * already say which they want by using `HH` or `hh`.
 */
export function createDateFormatter(
  preference: unknown,
  hourCycle: 'h12' | 'h23' | null,
): DateFormatter {
  const resolved = typeof preference === 'string' ? preference : 'locale';
  return (date) => {
    if (!date) return '—';
    const value = new Date(date);
    if (Number.isNaN(value.getTime())) return '—';
    if (resolved === 'locale')
      return value
        .toLocaleDateString(undefined, {
          day: '2-digit',
          month: '2-digit',
          year: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          ...(hourCycle ? { hourCycle } : {}),
        })
        .replace(/,\s*/, ' ');

    const pad = (n: number) => String(n).padStart(2, '0');
    const hour24 = value.getHours();
    const hour12 = hour24 % 12 || 12;
    const replacements: Record<string, string> = {
      yyyy: String(value.getFullYear()),
      MM: pad(value.getMonth() + 1),
      dd: pad(value.getDate()),
      HH: pad(hour24),
      hh: pad(hour12),
      mm: pad(value.getMinutes()),
      a: hour24 < 12 ? 'AM' : 'PM',
    };
    const pattern = resolved === 'iso' ? "yyyy-MM-dd'T'HH:mm" : resolved;
    return pattern.replace(
      /yyyy|MM|dd|HH|hh|mm|a|'([^']*)'/g,
      (token: string, literal: string | undefined) => literal ?? replacements[token] ?? token,
    );
  };
}

/**
 * Log timestamps: `time` for the panel, down to the millisecond — a protocol
 * exchange is over within one second — and `dateTime` for copied and saved
 * text, which may span days. Both follow the preference's 12- or 24-hour clock
 * and, for `dateTime`, its date order.
 */
export interface LogTimeFormatter {
  time: (timestamp: number) => string;
  dateTime: (timestamp: number) => string;
}

export function createLogTimeFormatter(
  preference: unknown,
  hourCycle: 'h12' | 'h23' | null,
): LogTimeFormatter {
  const resolved = typeof preference === 'string' ? preference : 'locale';
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  if (resolved === 'locale') {
    const time = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      ...(hourCycle ? { hourCycle } : {}),
    });
    const date = new Intl.DateTimeFormat(undefined, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
    return {
      time: (timestamp) => time.format(timestamp),
      dateTime: (timestamp) => `${date.format(timestamp)} ${time.format(timestamp)}`,
    };
  }
  const twelveHour = resolved.includes('hh');
  const datePattern = resolved === 'iso' ? 'yyyy-MM-dd' : (resolved.split(' ')[0] ?? 'yyyy-MM-dd');
  const time = (timestamp: number) => {
    const value = new Date(timestamp);
    const hours = value.getHours();
    const clock = `${pad(twelveHour ? hours % 12 || 12 : hours)}:${pad(value.getMinutes())}:${pad(
      value.getSeconds(),
    )}.${pad(value.getMilliseconds(), 3)}`;
    return twelveHour ? `${clock} ${hours < 12 ? 'AM' : 'PM'}` : clock;
  };
  const date = (timestamp: number) => {
    const value = new Date(timestamp);
    const parts: Record<string, string> = {
      yyyy: String(value.getFullYear()),
      MM: pad(value.getMonth() + 1),
      dd: pad(value.getDate()),
    };
    return datePattern.replace(/yyyy|MM|dd/g, (token) => parts[token] ?? token);
  };
  return { time, dateTime: (timestamp) => `${date(timestamp)} ${time(timestamp)}` };
}

/**
 * The live formatter, owned by settings because the preference is a setting.
 *
 * It is a subscribable store rather than a value threaded through props: the
 * readers are a file-row cell, a pane title tooltip, and a source-switcher
 * tooltip, five to seven components below the settings dialog, none of which
 * otherwise care about settings. The app deliberately avoids React Context for
 * state flow, so this matches how `transferStore` already publishes state that
 * every pane reads.
 *
 * What it replaces is a mutable `let` in `src/utils.ts` — a module every layer
 * imports — whose only change notification was a bare DOM event on `window`
 * that one component listened for and turned into a forced re-render. Here the
 * subscription is the notification, so React re-renders the readers and nothing
 * else, and a test drives the formatter through {@link createDateFormatter}
 * without touching this store at all.
 */
let formatter: DateFormatter = createDateFormatter('locale', null);
let logTimeFormatter: LogTimeFormatter = createLogTimeFormatter('locale', null);
let preference = 'locale';
let systemHourCycle: 'h12' | 'h23' | null = null;
const subscribers = new Set<() => void>();

export function setDateFormatPreference(
  next: unknown,
  hourCycle: 'h12' | 'h23' | null = systemHourCycle,
): void {
  const resolved = typeof next === 'string' ? next : 'locale';
  if (resolved === preference && hourCycle === systemHourCycle) return;
  preference = resolved;
  systemHourCycle = hourCycle;
  formatter = createDateFormatter(preference, systemHourCycle);
  logTimeFormatter = createLogTimeFormatter(preference, systemHourCycle);
  for (const notify of subscribers) notify();
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

/** The formatter for the current preference; re-renders the caller on change. */
export function useDateFormatter(): DateFormatter {
  return useSyncExternalStore(
    subscribe,
    () => formatter,
    () => formatter,
  );
}

/** The log timestamp formatter for the current preference. */
export function useLogTimeFormatter(): LogTimeFormatter {
  return useSyncExternalStore(
    subscribe,
    () => logTimeFormatter,
    () => logTimeFormatter,
  );
}
