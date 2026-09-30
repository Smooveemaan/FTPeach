/** Site and connection data shared by the connection bar, the panes, the site manager and IPC. */
export type SiteProtocol = 'ftp' | 'ftps' | 'sftp' | 'webdav';
export type SiteKind = 'site' | 'local' | 'folder';

/**
 * A server as the backend stores it and connects to it: the fields of
 * `domain::ServerSettings`. It holds no secret.
 */
export interface ServerSettings {
  protocol: SiteProtocol;
  host: string;
  port: number | null;
  webdavUrl: string;
  user: string;
  /** The folder a saved site opens in. */
  remotePath: string;
  allowInvalidCert: boolean;
  /** Sending the password over an unencrypted `http://` WebDAV address. */
  allowCleartextAuth: boolean;
  caCertPath: string;
  useKeyAuth: boolean;
  keyPath: string;
  /** FTP file name encoding; empty means UTF-8. */
  encoding: string;
  /** `0` or `null` is no limit. */
  maxConnections: number | null;
}

export interface ConnectionForm {
  protocol: SiteProtocol;
  host: string;
  port: string;
  webdavUrl: string;
  user: string;
  password: string;
  allowInvalidCert: boolean;
  /** Sending the password over an unencrypted `http://` WebDAV address. */
  allowCleartextAuth: boolean;
  caCertPath: string;
  useKeyAuth: boolean;
  keyPath: string;
  keyPassphrase: string;
}

export interface ManagedSite {
  maxConnections?: number;
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
  allowCleartextAuth?: boolean;
  caCertPath?: string;
  /** FTP file name encoding; empty means UTF-8. */
  encoding?: string;
  useKeyAuth?: boolean;
  keyPath?: string;
  icon?: string;
  color?: string;
}
