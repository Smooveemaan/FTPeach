import { useEffect, useRef, useState } from 'react';
import { api } from '../../platform/api/index.ts';
import type { LogEntry } from '../../shared/types.ts';
import { hasLogGap, MAX_LOG_LINES, mergeLogBatch } from './logBuffer.ts';

export type { LogEntry } from '../../shared/types.ts';

interface LogApi {
  recent: () => Promise<LogEntry[]>;
  onMessage: (callback: (batch: LogEntry[]) => void) => () => void;
}

export interface LogLinesModel {
  lines: readonly LogEntry[];
  clear: () => void;
}

/**
 * The protocol log for the panel. The backend records whether or not anyone
 * is looking, so this only reads: while `enabled`, it takes the history the
 * backend holds and then follows the live batches. Closed, it holds nothing.
 */
export function useLogLines(enabled: boolean, logApi: LogApi = api.log): LogLinesModel {
  const [lines, setLines] = useState<readonly LogEntry[]>([]);
  // The newest record the panel has taken in, and the newest one the user
  // cleared. Both outlive a closed panel, so a cleared log stays cleared.
  const lastSeqRef = useRef(0);
  const clearedThroughRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    // Live batches that arrive while the history is loading wait here.
    let pending: LogEntry[][] | null = [];

    const apply = (batch: LogEntry[]) => {
      const afterSeq = lastSeqRef.current;
      lastSeqRef.current = Math.max(afterSeq, batch.at(-1)?.seq ?? afterSeq);
      setLines((previous) => mergeLogBatch(previous, batch, afterSeq));
    };

    const load = () => {
      void logApi.recent().then((history) => {
        if (disposed) return;
        const clearedThrough = clearedThroughRef.current;
        lastSeqRef.current = Math.max(history.at(-1)?.seq ?? 0, clearedThrough);
        setLines(history.filter((entry) => entry.seq > clearedThrough).slice(-MAX_LOG_LINES));
        const queued = pending ?? [];
        pending = null;
        // Read once: if the history could not close the gap, take what came.
        for (const batch of queued) apply(batch);
      });
    };

    const unsubscribe = logApi.onMessage((batch) => {
      if (batch.length === 0) return;
      if (pending) {
        pending.push(batch);
      } else if (hasLogGap(lastSeqRef.current, batch)) {
        pending = [batch];
        load();
      } else {
        apply(batch);
      }
    });
    load();

    return () => {
      disposed = true;
      unsubscribe();
      setLines([]);
    };
  }, [enabled, logApi]);

  return {
    lines,
    clear: () => {
      clearedThroughRef.current = lastSeqRef.current;
      setLines([]);
    },
  };
}
