// FTPS (explicit TLS) through the real window against IIS, judged on the
// server's own disk.
//
// The server is the IIS FTP site of scripts/test-servers/iis.ps1, whose
// self-signed certificate for localhost is exported to cert.pem. Its CA can
// only be picked in a native file dialog, which a test cannot drive, so the
// trusting test starts from a bookmark saved with it, as a user's would be.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import {
  copyAcross,
  localPane,
  openFolder,
  payload,
  remotePane,
  serverTest,
  settledRow,
  sha256,
  startConnecting,
  uniqueName,
  waitConnected,
  type Server,
} from './panes.ts';

const server: Server = {
  protocol: 'FTPS',
  // The name the certificate is issued for.
  host: process.env.FTPEACH_E2E_FTPS_HOST ?? 'localhost',
  port: process.env.FTPEACH_E2E_FTPS_PORT ?? '2121',
  user: process.env.FTPEACH_E2E_FTPS_USER ?? 'ftpeach_test',
  password: process.env.FTPEACH_E2E_FTPS_PASSWORD ?? 'FTPeach-test-2026!',
  root: process.env.FTPEACH_E2E_FTPS_ROOT ?? 'C:\\ftpeach-test-servers\\iis\\FTPeachTestFtp',
};
const caCertPath = process.env.FTPEACH_E2E_FTPS_CA ?? 'C:\\ftpeach-test-servers\\iis\\cert.pem';

const test = serverTest(server, 'run iis.ps1 install');

test('an FTPS server whose certificate nothing vouches for is refused', async ({ app }) => {
  await startConnecting(app.page, server);

  const remote = remotePane(app.page);
  await expect(remote).toContainText('The server presented an invalid certificate', {
    timeout: 30_000,
  });
  await expect(remote.getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(0);
});

test.describe('with a bookmark saved with the server certificate', () => {
  const bookmark = 'IIS FTPS';
  test.use({
    appStore: {
      'sites.json': [
        {
          id: 'e2e-ftps',
          name: bookmark,
          protocol: 'ftps',
          host: server.host,
          port: Number(server.port),
          user: server.user,
          // A password saved in plain text by an older version; the store
          // protects it with DPAPI the first time it reads the file.
          plain: server.password,
          caCertPath,
          allowInvalidCert: false,
        },
      ],
    },
  });

  test('an upload over FTPS from the bookmark lands byte for byte', async ({ serverRoot, app }) => {
    const { page } = app;
    const bytes = payload();
    const name = uniqueName();
    writeFileSync(path.join(app.workDir, name), bytes);
    await openFolder(localPane(page), app.workDir);

    await remotePane(page).getByRole('button', { name: 'Manage Bookmarks…', exact: true }).click();
    const manager = page.getByRole('dialog');
    await manager.getByRole('treeitem', { name: bookmark }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
    await waitConnected(page);
    // IIS also takes plain FTP on this port, so a bookmark that skipped TLS
    // would pass the rest. The certificate check that the test above proves
    // real happens in this handshake.
    await page.getByRole('button', { name: 'Show/hide log', exact: true }).click();
    await expect(page.getByText('TLS connection established.').first()).toBeVisible();

    await copyAcross(localPane(page), name);
    await expect(await settledRow(page, name)).toHaveAccessibleName(/: Done\b/);
    expect(serverRoot.added()).toEqual([name]);
    expect(sha256(readFileSync(path.join(server.root, name)))).toBe(sha256(bytes));
  });
});
