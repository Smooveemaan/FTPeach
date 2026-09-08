import { useEffect, useRef, useState } from 'react';
import { api } from '../../platform/api/index.ts';
import type { LogEntry } from '../../shared/types.ts';
import { appendLogBatch } from './logBuffer.ts';
import type { StampedLogEntry } from './logBuffer.ts';

export type { LogEntry } from '../../shared/types.ts';

export type { StampedLogEntry } from './logBuffer.ts';

interface LogApi {
  onMessage: (callback: (batch: LogEntry[]) => void) => () => void;
}

export interface LogLinesModel {
  lines: StampedLogEntry<LogEntry>[];
  clear: () => void;
}

export function useLogLines(logApi: LogApi = api.log): LogLinesModel {
  const [lines, setLines] = useState<Array<StampedLogEntry<LogEntry>>>([]);
  const idCounterRef = useRef(0);

  useEffect(
    () =>
      logApi.onMessage((batch) => {
        if (batch.length === 0) return;
        const firstId = idCounterRef.current;
        idCounterRef.current += batch.length;
        setLines((previous) => {
          // React may replay this updater; allocating IDs belongs to the event callback.
          let id = firstId;
          return appendLogBatch(previous, batch, () => ++id);
        });
      }),
    [logApi],
  );

  return { lines, clear: () => setLines([]) };
}
