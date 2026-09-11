import assert from 'node:assert/strict';
import test from 'node:test';
import { createPaneSessionLifecycle } from '../../../src/features/file-browser/panes/createPaneSessionLifecycle.ts';
import { makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';
import type { CommandResult } from '../../../src/platform/ipcContracts.ts';
import { paneClient } from '../helpers/paneClient.ts';

function harness(
  reply?: Parameters<typeof paneClient>[0],
  listing: CommandResult | Promise<CommandResult> = { ok: true },
) {
  const h = paneClient(reply);
  const tab = makeTab('tab');
  const requests = { a: 0, b: 0 };
  const events: string[] = [];
  const refreshes: string[] = [];
  const listingErrors: string[] = [];
  let retry: (() => unknown) | undefined;
  const lifecycle = createPaneSessionLifecycle({
    client: h.client,
    connectTimeout: 20,
    ftpActiveMode: true,
    panes: tab.panes,
    activeTabId: tab.id,
    setTabs: (updater) => {
      const next = typeof updater === 'function' ? updater([tab]) : updater;
      Object.assign(tab, next[0]);
    },
    updatePane: (id, patch) => {
      tab.panes[id] = {
        ...tab.panes[id],
        ...(typeof patch === 'function' ? patch(tab.panes[id]) : patch),
      };
    },
    ensureRequestIds: () => requests,
    refreshPane: async (_id, path) => {
      refreshes.push(path);
      listingErrors.push(tab.panes.b.errorMessage);
      return listing;
    },
    pushRecentSite: (id) => {
      events.push(`recent:${id}`);
    },
    onVaultUnlockRequired: (callback) => {
      retry = callback;
    },
    requestConfirm: () => assert.fail('unexpected confirmation'),
    inFlightRefreshesRef: { current: {} },
    stopTransfersForConnection: async (id) => {
      events.push(`stop:${id}`);
    },
    t: (key) => key,
  });
  return { ...h, tab, requests, events, refreshes, listingErrors, lifecycle, retry: () => retry };
}

test('connection maps FTPS configuration and becomes connected only after initial listing', async () => {
  const h = harness();
  h.tab.panes.b.form = {
    ...h.tab.panes.b.form,
    protocol: 'ftps',
    host: 'example.org',
    port: '990',
  };
  await h.lifecycle.connectPane('b', undefined, undefined, 'tab', '/saved')();
  const config = h.calls[0]!.args!.config as Record<string, unknown>;
  assert.equal(config.protocol, 'ftp');
  assert.equal(config.secure, true);
  assert.equal(config.port, 990);
  assert.equal(config.activeMode, true);
  assert.equal(
    config.concurrency,
    undefined,
    'global concurrency must not cap individual sessions',
  );
  assert.equal(config.timeout, 20);
  assert.deepEqual(h.refreshes, ['/saved']);
  assert.equal(h.tab.panes.b.status, 'connected');
});

test('failed initial listing closes the half-open session and leaves an error state', async () => {
  const h = harness(undefined, { ok: false, errorCode: 'permissionDenied', error: 'denied' });
  await h.lifecycle.connectPane('b')();
  assert.equal(h.tab.panes.b.status, 'error');
  assert.ok(h.tab.panes.b.errorMessage);
  assert.deepEqual(
    h.calls.map((call) => call.command),
    ['session_connect', 'session_disconnect'],
  );
});

test('invalid WebDAV addresses stay in the pane without starting a session', async () => {
  for (const webdavUrl of ['localhost', 'localhost:6065', 'ftp://localhost:6065/']) {
    const h = harness();
    h.tab.panes.b.form = { ...h.tab.panes.b.form, protocol: 'webdav', webdavUrl };
    await h.lifecycle.connectPane('b')();
    assert.equal(h.tab.panes.b.status, 'error');
    assert.ok(h.tab.panes.b.errorMessage);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.refreshes, []);
  }
});

test('WebDAV accepts an absolute URL with a custom port', async () => {
  const h = harness();
  h.tab.panes.b.form = {
    ...h.tab.panes.b.form,
    protocol: 'webdav',
    webdavUrl: 'http://localhost:6065/',
  };
  await h.lifecycle.connectPane('b')();
  assert.equal(h.tab.panes.b.status, 'connected');
  assert.equal(
    (h.calls[0]!.args!.config as Record<string, unknown>).webdavUrl,
    'http://localhost:6065/',
  );
});

test('cancellation invalidates a pending connection and closes its late successful result', async () => {
  let resolve: (_result: CommandResult) => void = () => assert.fail('missing pending request');
  const h = harness((command) =>
    command === 'session_connect'
      ? new Promise<CommandResult>((done) => {
          resolve = done;
        })
      : { ok: true },
  );
  const connecting = h.lifecycle.connectPane('b')();
  h.lifecycle.cancelConnectPane('b');
  resolve({ ok: true });
  await connecting;
  assert.equal(h.tab.panes.b.status, 'idle');
  assert.deepEqual(h.refreshes, []);
  assert.deepEqual(
    h.calls.map((call) => call.command),
    ['session_connect', 'session_cancel_connect', 'session_disconnect'],
  );
});

test('locked vault exposes a retry that can complete after unlock', async () => {
  let locked = true;
  const h = harness(() => (locked ? { ok: false, errorCode: 'vaultLocked' } : { ok: true }));
  await h.lifecycle.connectPane('b')();
  assert.equal(h.tab.panes.b.status, 'idle');
  assert.ok(h.retry());
  locked = false;
  await h.retry()!();
  assert.equal(h.tab.panes.b.status, 'connected');
});

test('disconnect invalidates requests, stops transfers before IPC and clears navigation state', async () => {
  const h = harness((command) => {
    if (command === 'session_disconnect') assert.deepEqual(h.events, ['stop:session']);
    return { ok: true };
  });
  h.tab.syncBrowsing = true;
  h.tab.panes.b.connectionId = 'session';
  h.tab.panes.b.history = ['/old'];
  h.tab.panes.b.future = ['/next'];
  await h.lifecycle.disconnectPane('b');
  assert.equal(h.requests.b, 1);
  assert.equal(h.tab.syncBrowsing, false);
  assert.deepEqual(h.tab.panes.b.history, []);
  assert.deepEqual(h.tab.panes.b.future, []);
  assert.equal(h.tab.panes.b.status, 'idle');
});

test('a previous validation error stays cleared throughout connection and first listing', async () => {
  let finish!: (_result: CommandResult) => void;
  const h = harness((command) =>
    command === 'session_connect'
      ? new Promise<CommandResult>((resolve) => {
          finish = resolve;
        })
      : { ok: true },
  );
  h.tab.panes.b.errorMessage = 'The provided value is invalid.';
  h.tab.panes.b.status = 'error';
  const pending = h.lifecycle.connectPane('b')();
  assert.equal(h.tab.panes.b.errorMessage, '');
  finish({ ok: true });
  await Promise.resolve();
  await Promise.resolve();
  await pending;
  assert.equal(h.tab.panes.b.status, 'connected');
  assert.equal(h.tab.panes.b.errorMessage, '');
});

for (const lateResult of [{ ok: true }, { ok: false, errorCode: 'cancelled' }] as CommandResult[]) {
  test(
    'replacing a pending connection isolates its late ' +
      (lateResult.ok ? 'success' : 'cancellation'),
    async () => {
      const pending: ((_result: CommandResult) => void)[] = [];
      const h = harness((command) =>
        command === 'session_connect'
          ? new Promise<CommandResult>((resolve) => {
              pending.push(resolve);
            })
          : { ok: true },
      );
      const first = h.lifecycle.connectPane('b', { ...h.tab.panes.b.form, host: 'first' })();
      const firstId = h.tab.panes.b.connectionId;
      const second = h.lifecycle.connectPane('b', { ...h.tab.panes.b.form, host: 'second' })();
      const secondId = h.tab.panes.b.connectionId;
      assert.notEqual(firstId, secondId);
      assert.ok(
        h.calls.some(
          (call) =>
            call.command === 'session_cancel_connect' && call.args?.connectionId === firstId,
        ),
      );
      pending[1]!({ ok: true });
      await second;
      pending[0]!(lateResult);
      await first;
      assert.equal(h.tab.panes.b.status, 'connected');
      assert.equal(h.tab.panes.b.form.host, 'second');
      assert.equal(h.tab.panes.b.errorMessage, '');
      assert.equal(h.tab.panes.b.connectionId, secondId);
      assert.equal(
        h.calls.some(
          (call) => call.command === 'session_disconnect' && call.args?.connectionId === secondId,
        ),
        false,
      );
    },
  );
}

test('late first listing cannot overwrite a replacement connection', async () => {
  let finishListing!: (_result: CommandResult) => void;
  const h = harness(
    undefined,
    new Promise<CommandResult>((resolve) => {
      finishListing = resolve;
    }),
  );
  h.tab.panes.b.errorMessage = 'The provided value is invalid.';
  const first = h.lifecycle.connectPane('b')();
  while (h.refreshes.length === 0) await Promise.resolve();
  assert.deepEqual(h.listingErrors, ['']);
  const replacement = h.lifecycle.connectPane('b', {
    ...h.tab.panes.b.form,
    host: 'replacement',
  })();
  finishListing({ ok: false, errorCode: 'cancelled' });
  await first;
  assert.equal(h.tab.panes.b.errorMessage, '');
  await replacement;
});

test('editing a bookmark-filled form drops the bookmark caption along with its id', () => {
  const h = harness();
  h.tab.panes.b.siteLabel = 'SFTP';
  h.tab.panes.b.siteId = 'site-1';
  h.lifecycle.setPaneForm('b', {
    ...h.tab.panes.b.form,
    protocol: 'ftp',
    host: '127.0.0.1',
    port: '2131',
  });
  assert.equal(h.tab.panes.b.siteId, null);
  assert.equal(h.tab.panes.b.siteLabel, '');
});
