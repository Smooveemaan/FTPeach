export interface LogEntry {
  /** Increases by one per record across all connections; unique. */
  seq: number;
  line?: string;
  key?: string;
  params?: Record<string, unknown>;
  kind: string;
  ts: number;
  connectionId: string;
  /** The server as the backend names it, for connections with no tab label. */
  server?: string;
}
