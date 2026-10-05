import type { ConnectionForm, ManagedSite, SiteProtocol } from '../../../shared/siteContracts.ts';
import type { PaneKind, PaneStatus, FileEntry, PaneId } from '../../../shared/paneContracts.ts';

export type { ConnectionForm } from '../../../shared/siteContracts.ts';
export type { PaneId, PaneKind, PaneStatus } from '../../../shared/paneContracts.ts';

export interface PaneState {
  id: PaneId;
  kind: PaneKind;
  connectionId: string | null;
  protocol: SiteProtocol | null;
  siteLabel: string;
  siteId: string | null;
  form: ConnectionForm;
  status: PaneStatus;
  errorMessage: string;
  path: string;
  entries: FileEntry[];
  loading: boolean;
  selected: Set<string>;
  history: string[];
  future: string[];
  refreshedAt: number | null;
}
export interface TabState {
  id: string;
  name: string;
  panes: Record<PaneId, PaneState>;
  syncBrowsing: boolean;
}

export const PANE_IDS: readonly PaneId[] = ['a', 'b'];
export const otherPaneId = (id: PaneId): PaneId => (id === 'a' ? 'b' : 'a');

export const initialForm: ConnectionForm = {
  protocol: 'ftp',
  host: '',
  port: '',
  webdavUrl: '',
  user: '',
  password: '',
  allowInvalidCert: false,
  allowCleartextAuth: false,
  caCertPath: '',
  useKeyAuth: false,
  keyPath: '',
  keyPassphrase: '',
};

export const buildFormFromSite = (site: ManagedSite): ConnectionForm => ({
  protocol: site.protocol ?? 'ftp',
  host: site.host ?? '',
  port: String(site.port || (site.protocol === 'sftp' ? '22' : '21')),
  webdavUrl: site.webdavUrl || '',
  user: site.user || '',
  password: '',
  allowInvalidCert: !!site.allowInvalidCert,
  allowCleartextAuth: !!site.allowCleartextAuth,
  caCertPath: site.caCertPath || '',
  useKeyAuth: !!site.useKeyAuth,
  keyPath: site.keyPath || '',
  keyPassphrase: '',
});

// A server reply such as "[425] ... data socket ..." came over a control
// connection that is still alive; only a lost connection sends none.
export const isConnectionLoss = (error = ''): boolean =>
  !/cancel(?:ed|led) by user/i.test(error) &&
  !/\[\d{3}\]/.test(error) &&
  /connection (?:closed|reset|lost|aborted)|broken pipe|socket|unexpected eof|timed? out/i.test(
    error,
  );

/**
 * Whether a command on a connected pane failed because the connection is
 * gone, so the pane shows the error and offers to connect again. WebDAV holds
 * no connection open: a server that refuses a new one has gone too.
 */
export const isLostConnection = (errorCode: string | undefined, error = ''): boolean =>
  errorCode === 'connectionLost' ||
  errorCode === 'timedOut' ||
  errorCode === 'connectionRefused' ||
  (errorCode !== 'cancelled' && isConnectionLoss(error));

/** A pane whose connection is gone, offering to connect again: the files it listed are no longer there to see. */
export const lostConnectionPane = (errorMessage: string): Partial<PaneState> => ({
  status: 'error',
  loading: false,
  errorMessage,
  entries: [],
  selected: new Set(),
  refreshedAt: null,
});

export function makePane(id: PaneId, kind: PaneKind): PaneState {
  return {
    id,
    kind,
    connectionId: null,
    protocol: null,
    siteLabel: '',
    siteId: null,
    form: { ...initialForm },
    status: 'idle',
    errorMessage: '',
    path: kind === 'remote' ? '/' : '',
    entries: [],
    loading: false,
    selected: new Set(),
    history: [],
    future: [],
    refreshedAt: null,
  };
}

export function makeTab(id: string): TabState {
  return {
    id,
    name: '',
    panes: { a: makePane('a', 'local'), b: makePane('b', 'remote') },
    syncBrowsing: false,
  };
}
