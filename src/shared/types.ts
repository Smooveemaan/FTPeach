export type SiteProtocol = 'ftp' | 'ftps' | 'sftp' | 'webdav';
export type SiteKind = 'site' | 'local' | 'folder';
export type PaneKind = 'local' | 'remote';
export type PaneId = 'a' | 'b';

export interface LogEntry {
  line?: string;
  key?: string;
  params?: Record<string, unknown>;
  kind: string;
  ts: number;
  connectionId: string;
}
export type PaneStatus = 'idle' | 'connecting' | 'connected' | 'error';
/**
 * i18next's `t`, narrowed to what this codebase calls it with. Two call
 * signatures rather than one optional parameter: an optional parameter also
 * accepts an explicit `undefined`, which i18next's own overloads do not, so a
 * single-signature alias stops accepting `TFunction` under
 * `exactOptionalPropertyTypes`.
 */
export interface Translate {
  (key: string): string;
  (key: string, values: Record<string, unknown>): string;
}

export interface ConnectionForm {
  protocol: SiteProtocol;
  host: string;
  port: string;
  webdavUrl: string;
  user: string;
  password: string;
  allowInvalidCert: boolean;
  caCertPath: string;
  useKeyAuth: boolean;
  keyPath: string;
  keyPassphrase: string;
}

export interface ManagedSite {
  id: string;
  kind?: SiteKind;
  name: string;
  parentId?: string | null;
  managerScope?: 'bookmarks' | 'localPaths';
  protocol?: SiteProtocol;
  host?: string;
  port?: number;
  webdavUrl?: string;
  user?: string;
  localPath?: string;
  remotePath?: string;
  hasPassword?: boolean;
  hasKeyPassphrase?: boolean;
  allowInvalidCert?: boolean;
  caCertPath?: string;
  useKeyAuth?: boolean;
  keyPath?: string;
  icon?: string;
  color?: string;
}

export interface SiteForm {
  kind: 'site' | 'local';
  name: string;
  localPath: string;
  protocol: SiteProtocol;
  host: string;
  port: string;
  webdavUrl: string;
  user: string;
  password: string;
  hasPassword: boolean;
  removePassword: boolean;
  remotePath: string;
  allowInvalidCert: boolean;
  caCertPath: string;
  useKeyAuth: boolean;
  keyPath: string;
  keyPassphrase: string;
  hasKeyPassphrase: boolean;
  removeKeyPassphrase: boolean;
  parentId: string | null;
  icon: string;
  color: string;
}

/**
 * Site ids per container. Any folder id can be a key, but the two synthetic
 * containers — the folder list and the root list — always exist, so they are
 * named here instead of being defended against at each lookup.
 */
export type SiteContainers = Record<string, string[]> & {
  __folders__: string[];
  __root__: string[];
};

export interface FileEntry {
  name: string;
  isDirectory: boolean;
  isHidden?: boolean;
  size?: number;
  modifiedAt?: string | number | null;
  createdAt?: string | number | null;
  permissions?: string;
  owner?: string;
  group?: string;
  path?: string;
}
