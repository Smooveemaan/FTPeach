/** Pane identity and state, and the directory entry every listing returns. */
export type PaneKind = 'local' | 'remote';
export type PaneId = 'a' | 'b';
export type PaneStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface FileEntry {
  name: string;
  isDirectory: boolean;
  isHidden?: boolean;
  size?: number;
  modifiedAt?: string | number | null;
  createdAt?: string | number | null;
  permissions?: string | null;
  owner?: string | null;
  group?: string | null;
  path?: string;
}
