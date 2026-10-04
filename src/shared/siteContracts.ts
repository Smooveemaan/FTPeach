/** Site and connection data shared by the connection bar, the panes, the site manager and IPC. */
export type SiteProtocol = 'ftp' | 'ftps' | 'sftp' | 'webdav';

/** The port each protocol connects to when the field is empty; WebDAV takes it from the URL. */
export const DEFAULT_PORTS: Record<SiteProtocol, string> = {
  ftp: '21',
  ftps: '21',
  sftp: '22',
  webdav: '',
};

/**
 * The port field after the protocol changes: empty or any protocol's default
 * becomes empty, so the new default applies (the field shows it as its
 * placeholder); a port the user chose stays, as in FileZilla.
 */
export function portAfterProtocolChange(port: string): string {
  const trimmed = port.trim();
  return Object.values(DEFAULT_PORTS).includes(trimmed) ? '' : port;
}
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

/**
 * An entry of `sites_list`: a server bookmark, a local folder or a folder.
 * The server fields are present on a bookmark and absent on the other two.
 */
export interface ManagedSite extends Partial<ServerSettings> {
  id: string;
  kind?: SiteKind;
  name: string;
  parentId?: string | null;
  managerScope?: 'bookmarks' | 'localPaths';
  localPath?: string;
  hasPassword?: boolean;
  hasKeyPassphrase?: boolean;
  icon?: string;
  color?: string;
}
