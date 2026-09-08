import { friendlyError, friendlyConnectError } from '../../../shared/errorMessages.ts';
import { buildFormFromSite, initialForm, otherPaneId } from './paneModel.ts';
import { reportRejection } from '../../../shared/asyncFailure.ts';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { CommandResult } from '../../../platform/ipcContracts.ts';
import type { ConnectionConfig } from '../../../platform/api/session.ts';
import type { ConnectionForm, ManagedSite } from '../../../shared/types.ts';
import type { Translate } from '../components/fileListModel.ts';
import type { PaneId, PaneState, TabState } from './paneModel.ts';
import { api } from '../../../platform/api/index.ts';

type PanePatch = Partial<PaneState> | ((pane: PaneState) => Partial<PaneState>);
type RequestIds = Record<string, Record<PaneId, number>>;
type InFlightRefreshes = Record<string, { key: string; promise: Promise<CommandResult | void> }>;

interface ConfirmOptions {
  confirmLabel?: string;
  danger?: boolean;
}

interface PaneSessionLifecycleOptions {
  client?: Pick<Window['api'], 'session'>;
  concurrency: number;
  connectTimeout: number;
  ftpActiveMode: boolean;
  panes: Record<PaneId, PaneState>;
  activeTabId: string;
  setTabs: Dispatch<SetStateAction<TabState[]>>;
  updatePane: (id: PaneId, patch: PanePatch, tabId?: string) => void;
  ensureRequestIds: (tabId: string) => RequestIds[string];
  refreshPane: (
    id: PaneId,
    path: string,
    paneOverride?: PaneState,
    tabId?: string,
  ) => Promise<CommandResult | void>;
  pushRecentSite: (siteId: string) => void;
  onVaultUnlockRequired: (retry: () => unknown) => void;
  requestConfirm: (message: string, onConfirm: () => unknown, options?: ConfirmOptions) => unknown;
  inFlightRefreshesRef: MutableRefObject<InFlightRefreshes>;
  stopTransfersForConnection: (connectionId: string) => Promise<unknown>;
  t: Translate;
}

export function createPaneSessionLifecycle({
  client = api,
  concurrency,
  connectTimeout,
  ftpActiveMode,
  panes,
  activeTabId,
  setTabs,
  updatePane,
  ensureRequestIds,
  refreshPane,
  pushRecentSite,
  onVaultUnlockRequired,
  requestConfirm,
  inFlightRefreshesRef,
  stopTransfersForConnection,
  t,
}: PaneSessionLifecycleOptions) {
  const buildSessionConfig = (
    f: ConnectionForm,
    siteId: string | null = null,
  ): ConnectionConfig => ({
    siteId,
    protocol: f.protocol === 'sftp' ? 'sftp' : f.protocol === 'webdav' ? 'webdav' : 'ftp',
    secure: f.protocol === 'ftps',
    host: f.host,
    port: f.port && !Number.isNaN(Number(f.port)) ? Number(f.port) : undefined,
    webdavUrl: f.webdavUrl,
    user: f.user,
    password: f.password,
    allowInvalidCert: !!f.allowInvalidCert,
    caCertPath: f.caCertPath,
    concurrency,
    timeout: connectTimeout,
    useKeyAuth: f.protocol === 'sftp' && !!f.useKeyAuth,
    keyPath: f.keyPath,
    keyPassphrase: f.keyPassphrase,
    // Global setting, not a per-site form field; only protocol/ftp.rs reads
    // it (suppaftp defaults to passive already), harmless no-op for SFTP/WebDAV.
    activeMode: !!ftpActiveMode,
  });

  const startPaneConnect = (id: PaneId, tabId = activeTabId) => {
    const pane = panes[id];
    if (pane.kind === 'remote' && (pane.status === 'connected' || pane.status === 'connecting')) {
      reportRejection(
        stopTransfersForConnection(pane.connectionId!).then(() =>
          client.session.disconnect(pane.connectionId!),
        ),
      );
      if (pane.status === 'connecting') ensureRequestIds(tabId)[id] += 1;
    }
    updatePane(
      id,
      {
        kind: 'remote',
        status: 'idle',
        errorMessage: '',
        form: initialForm,
        siteLabel: '',
        siteId: null,
        path: '/',
        entries: [],
        history: [],
        future: [],
        refreshedAt: null,
      },
      tabId,
    );
  };

  const switchPaneToLocal = (id: PaneId, tabId = activeTabId, targetPath = '') => {
    const pane = panes[id];
    if (pane.kind === 'remote' && (pane.status === 'connected' || pane.status === 'connecting')) {
      reportRejection(
        stopTransfersForConnection(pane.connectionId!).then(() =>
          client.session.disconnect(pane.connectionId!),
        ),
      );
      // See startPaneConnect's identical bump for why this matters.
      if (pane.status === 'connecting') ensureRequestIds(tabId)[id] += 1;
    }
    // A jump to a saved path is normal pane navigation, so it joins the Back
    // stack too — unless the pane's kind changes, which resets history/future.
    const staysLocal = pane.kind === 'local';
    const previousPath = pane.path;
    const nextPane: PaneState = {
      ...pane,
      kind: 'local',
      connectionId: null,
      protocol: null,
      status: 'idle',
      errorMessage: '',
      siteId: null,
      path: targetPath || '',
      history:
        staysLocal && previousPath && previousPath !== (targetPath || '')
          ? [...pane.history, previousPath]
          : [],
      future: [],
    };
    updatePane(id, nextPane, tabId);
    if (panes[otherPaneId(id)].kind === 'local') {
      setTabs((prev) => prev.map((t) => (t.id !== tabId ? t : { ...t, syncBrowsing: false })));
    }
    reportRejection(refreshPane(id, targetPath, nextPane, tabId));
  };

  const setPaneForm = (id: PaneId, form: ConnectionForm) => updatePane(id, { form, siteId: null });

  const connectPane =
    (
      id: PaneId,
      overrideForm?: ConnectionForm,
      paneOverride?: PaneState,
      tabId = activeTabId,
      startPath = '/',
    ) =>
    async () => {
      const pane = paneOverride || panes[id];
      const f = overrideForm || pane.form;
      if (f.protocol === 'webdav') {
        let validUrl = false;
        try {
          const url = new URL(f.webdavUrl);
          validUrl = ['http:', 'https:'].includes(url.protocol) && !!url.hostname;
        } catch {
          // An address without a scheme is not an absolute WebDAV URL.
        }
        if (!validUrl) {
          updatePane(
            id,
            {
              status: 'error',
              errorMessage: friendlyConnectError({ code: 'invalidInput' }) || '',
            },
            tabId,
          );
          return;
        }
      }
      if (pane.siteId) pushRecentSite(pane.siteId);
      const previousConnectionId = pane.connectionId;
      const connectionId = crypto.randomUUID();
      const requestIds = ensureRequestIds(tabId);
      const requestId = (requestIds[id] += 1);
      delete inFlightRefreshesRef.current[`${tabId}:${id}`];
      if (previousConnectionId) {
        if (pane.status === 'connecting') {
          reportRejection(client.session.cancelConnect(previousConnectionId));
        }
        reportRejection(
          stopTransfersForConnection(previousConnectionId).then(() =>
            client.session.disconnect(previousConnectionId),
          ),
        );
      }
      updatePane(
        id,
        {
          kind: 'remote',
          status: 'connecting',
          errorMessage: '',
          loading: false,
          connectionId,
          form: f,
          path: '/',
          entries: [],
          selected: new Set(),
          history: [],
          future: [],
          refreshedAt: null,
        },
        tabId,
      );
      const res = await client.session.connect(connectionId, buildSessionConfig(f, pane.siteId));
      if (requestId !== requestIds[id]) {
        // This connect was superseded by a newer one; closing the orphan is
        // housekeeping the user never asked for, so a failure has nothing to
        // tell them and must not displace the newer attempt's own message.
        if (res.ok) void client.session.disconnect(connectionId);
        return;
      }
      if (res.ok) {
        const nextPane: PaneState = {
          ...pane,
          kind: 'remote',
          status: 'connecting',
          errorMessage: '',
          protocol: f.protocol,
          history: [],
          future: [],
          connectionId,
          form: f,
        };
        updatePane(id, nextPane, tabId);
        const listing = refreshPane(id, startPath || '/', nextPane, tabId);
        const listingRequestId = requestIds[id];
        const listRes = await listing;
        if (listingRequestId !== requestIds[id]) return;
        if (listRes === undefined) return; // cancelled, or superseded, while listing
        if (listRes.ok) {
          updatePane(id, { status: 'connected', errorMessage: '' }, tabId);
        } else {
          // The listing failure below is the message worth showing; a
          // failure to close the half-open session would only overwrite it.
          void client.session.disconnect(connectionId);
          updatePane(
            id,
            {
              status: 'error',
              errorMessage:
                friendlyConnectError(
                  listRes.errorCode
                    ? { code: listRes.errorCode, message: listRes.error }
                    : listRes.error,
                ) || '',
            },
            tabId,
          );
        }
        return;
      }
      updatePane(id, { status: 'error' }, tabId);
      if (res.errorCode === 'vaultLocked' || /vault is locked/i.test(res.error || '')) {
        updatePane(id, { status: 'idle', errorMessage: '' }, tabId);
        onVaultUnlockRequired(() => connectPane(id, f, pane, tabId, startPath)());
        return;
      }
      if (res.hostKeyMismatch) {
        const { host, port } = res.hostKeyMismatch;
        requestConfirm(
          t('confirm.hostKeyMismatch', {
            error: res.diagnosticDetails || res.error,
            host,
            port,
          }),
          async () => {
            const forgetRes = await client.session.forgetHostKey(host, port);
            if (!forgetRes.ok) {
              updatePane(
                id,
                {
                  errorMessage:
                    friendlyError(
                      forgetRes.errorCode
                        ? { code: forgetRes.errorCode, message: forgetRes.error }
                        : forgetRes.error,
                    ) || '',
                },
                tabId,
              );
              return;
            }
            reportRejection(connectPane(id, f, undefined, tabId, startPath)());
          },
          { confirmLabel: t('confirm.connectAnyway'), danger: true },
        );
        return;
      }
      updatePane(
        id,
        {
          errorMessage:
            friendlyConnectError(
              res.errorCode ? { code: res.errorCode, message: res.error } : res.error,
            ) || '',
        },
        tabId,
      );
    };

  const disconnectPane = async (id: PaneId, tabId = activeTabId) => {
    const pane = panes[id];
    if (!pane.connectionId) return;
    ensureRequestIds(tabId)[id] += 1;
    delete inFlightRefreshesRef.current[`${tabId}:${id}`];
    updatePane(
      id,
      {
        status: 'idle',
        entries: [],
        path: '/',
        history: [],
        future: [],
        refreshedAt: null,
        errorMessage: '',
      },
      tabId,
    );
    setTabs((prev) => prev.map((t) => (t.id !== tabId ? t : { ...t, syncBrowsing: false })));
    await stopTransfersForConnection(pane.connectionId);
    await client.session.disconnect(pane.connectionId);
  };

  const cancelConnectPane = (id: PaneId, tabId = activeTabId) => {
    const pane = panes[id];
    if (pane.status !== 'connecting' || !pane.connectionId) return;
    reportRejection(client.session.cancelConnect(pane.connectionId));
    ensureRequestIds(tabId)[id] += 1;
    updatePane(id, { status: 'idle', errorMessage: '' }, tabId);
  };

  const siteConnectPane = (id: PaneId, site: ManagedSite, tabId = activeTabId) => {
    const f = buildFormFromSite(site);
    const nextPane: PaneState = {
      ...panes[id],
      kind: 'remote',
      form: f,
      siteLabel: site.name,
      siteId: site.id,
    };
    updatePane(id, nextPane, tabId);
    reportRejection(connectPane(id, f, nextPane, tabId, site.remotePath || '/')());
  };

  return {
    startPaneConnect,
    switchPaneToLocal,
    setPaneForm,
    connectPane,
    disconnectPane,
    cancelConnectPane,
    siteConnectPane,
  };
}
