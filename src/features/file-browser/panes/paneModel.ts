import type {
  ConnectionForm,
  ManagedSite,
  PaneKind,
  PaneStatus,
  FileEntry,
  SiteProtocol,
  PaneId,
} from '../../../shared/types.ts';

export type { ConnectionForm, PaneId, PaneKind, PaneStatus } from '../../../shared/types.ts';

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
  caCertPath: site.caCertPath || '',
  useKeyAuth: !!site.useKeyAuth,
  keyPath: site.keyPath || '',
  keyPassphrase: '',
});

export const isConnectionLoss = (error = ''): boolean =>
  !/cancel(?:ed|led) by user/i.test(error) &&
  /connection (?:closed|reset|lost|aborted)|broken pipe|socket|unexpected eof|timed? out/i.test(
    error,
  );

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
