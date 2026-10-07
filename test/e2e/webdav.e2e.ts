// WebDAV through the real window, judged on the server's own disk, and on
// what a server was actually sent.
//
// The server is the IIS WebDAV site of scripts/test-servers/iis.ps1 at
// http://127.0.0.1:18180/ unless the FTPEACH_E2E_DAV_* variables name another.
// Over http:// a password travels readable, so FTPeach sends it only after
// Allow unencrypted sign-in is ticked; a server of the test's own records
// every request to check that.
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import {
  copyAcross,
  fileRow,
  isStaging,
  localPane,
  openFolder,
  payload,
  remotePane,
  runningRow,
  serverTest,
  settledRow,
  sha256,
  startConnecting,
  uniqueName,
  waitConnected,
  type Server,
} from './panes.ts';

const server: Server = {
  protocol: 'WebDAV',
  host: process.env.FTPEACH_E2E_DAV_URL ?? 'http://127.0.0.1:18180/',
  port: '',
  user: process.env.FTPEACH_E2E_DAV_USER ?? 'ftpeach_test',
  password: process.env.FTPEACH_E2E_DAV_PASSWORD ?? 'FTPeach-test-2026!',
  root: process.env.FTPEACH_E2E_DAV_ROOT ?? 'C:\\ftpeach-test-servers\\iis\\FTPeachTestDav',
  allowCleartext: true,
};

const test = serverTest(server, 'run iis.ps1 install');

/**
 * An http:// server that refuses everyone and keeps the headers of every
 * request it was sent.
 */
async function recordingServer() {
  const requests: IncomingHttpHeaders[] = [];
  const http = createServer((request, response) => {
    requests.push(request.headers);
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="e2e"' }).end();
  });
  // FTPeach tries https:// first; a TLS hello is not HTTP.
  http.on('clientError', (_, socket) => socket.destroy());
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    close: () => new Promise((resolve) => http.close(resolve)),
  };
}

for (const allowCleartext of [false, true]) {
  test(`over http:// the password is sent ${allowCleartext ? 'once unencrypted sign-in is allowed' : 'never, until unencrypted sign-in is allowed'}`, async ({
    app,
  }) => {
    const recorder = await recordingServer();
    try {
      await startConnecting(app.page, {
        ...server,
        host: recorder.url,
        user: 'e2e-user',
        password: 'e2e-secret',
        allowCleartext,
      });
      const remote = remotePane(app.page);
      // The attempt is over once the pane can connect again.
      await expect(remote.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled({
        timeout: 30_000,
      });
      await expect(remote.getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(0);

      // FTPeach did reach the server: its first request goes out without a
      // password either way.
      expect(recorder.requests.length).toBeGreaterThan(0);
      const sent = recorder.requests
        .map((headers) => headers.authorization)
        .filter((value) => value !== undefined);
      const basic = `Basic ${Buffer.from('e2e-user:e2e-secret').toString('base64')}`;
      if (allowCleartext) {
        expect(sent).toContain(basic);
      } else {
        expect(sent).toEqual([]);
      }
    } finally {
      await recorder.close();
    }
  });
}

test('a file uploaded and downloaded over WebDAV arrives byte for byte both ways', async ({
  serverRoot,
  app,
}) => {
  const { page } = app;
  const up = uniqueName();
  const down = uniqueName();
  const upBytes = payload();
  const downBytes = payload();
  writeFileSync(path.join(app.workDir, up), upBytes);
  writeFileSync(path.join(server.root, down), downBytes);

  await openFolder(localPane(page), app.workDir);
  await startConnecting(page, server);
  await waitConnected(page);

  await copyAcross(localPane(page), up);
  await expect(await settledRow(page, up)).toHaveAccessibleName(/: Done\b/);
  await copyAcross(remotePane(page), down);
  await expect(await settledRow(page, down)).toHaveAccessibleName(/: Done\b/);

  expect(serverRoot.added().sort()).toEqual([up, down].sort());
  expect(sha256(readFileSync(path.join(server.root, up)))).toBe(sha256(upBytes));
  expect(readdirSync(app.workDir).sort()).toEqual([up, down].sort());
  expect(sha256(readFileSync(path.join(app.workDir, down)))).toBe(sha256(downBytes));
  await expect(fileRow(remotePane(page), up)).toBeVisible({ timeout: 15_000 });
});

test.describe('with a speed limit, so a transfer is still running when Stop is pressed', () => {
  // 3 MB at 256 KB/s takes about twelve seconds.
  test.use({ appSettings: { transferSpeedLimitKBps: 256 } });

  test('stopping an upload over an existing file keeps the old file and leaves nothing behind', async ({
    serverRoot,
    app,
  }) => {
    const { page } = app;
    const name = uniqueName();
    const old = payload();
    writeFileSync(path.join(server.root, name), old);
    writeFileSync(path.join(app.workDir, name), payload());

    await openFolder(localPane(page), app.workDir);
    await startConnecting(page, server);
    await waitConnected(page);
    await fileRow(remotePane(page), name).waitFor({ timeout: 15_000 });
    await copyAcross(localPane(page), name);
    await page.getByRole('dialog').getByRole('button', { name: 'Overwrite', exact: true }).click();

    const running = runningRow(page, name);
    await running.waitFor({ timeout: 30_000 });
    await running.getByRole('button', { name: 'Stop', exact: true }).click();

    await expect(await settledRow(page, name)).toHaveAccessibleName(/: Cancelled\b/);
    await expect
      .poll(() => serverRoot.added().filter((entry) => entry === name || isStaging(entry)), {
        timeout: 15_000,
      })
      .toEqual([name]);
    expect(serverRoot.added()).toEqual([name]);
    expect(sha256(readFileSync(path.join(server.root, name)))).toBe(sha256(old));
  });
});
