// SFTP through the real window, IPC and Rust backend to a real server, judged
// on the server's own disk and the local disk.
//
// The server is OpenSSH from scripts/test-servers/openssh.ps1 unless the
// FTPEACH_E2E_SFTP_* variables name another; FTPEACH_E2E_SFTP_ROOT is the
// folder the account lands in and FTPEACH_E2E_SFTP_HOST_KEY the server's public
// host key file. OpenSSH keeps a partly uploaded file, so unlike IIS FTP these
// tests see what FTPeach itself leaves behind on Stop and what it appends to on
// Resume.
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import type { RunningApp } from './app.ts';
import {
  copyAcross,
  fileRow,
  isStaging,
  localPane,
  openFolder,
  payload,
  queueRow,
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
  protocol: 'SFTP',
  host: process.env.FTPEACH_E2E_SFTP_HOST ?? '127.0.0.1',
  port: process.env.FTPEACH_E2E_SFTP_PORT ?? '2223',
  user: process.env.FTPEACH_E2E_SFTP_USER ?? 'ftpeach_test',
  password: process.env.FTPEACH_E2E_SFTP_PASSWORD ?? 'FTPeach-test-2026!',
  root: process.env.FTPEACH_E2E_SFTP_ROOT ?? 'C:\\ftpeach-test-servers\\openssh\\root',
};
const hostKeyFile =
  process.env.FTPEACH_E2E_SFTP_HOST_KEY ??
  'C:\\ftpeach-test-servers\\openssh\\ssh_host_ed25519_key.pub';

const test = serverTest(server, 'run iis.ps1 install, then openssh.ps1 install');

/** The fingerprint FTPeach shows: SHA-256 of the key blob, in lowercase hex. */
function hostKeyFingerprint() {
  const blob = Buffer.from(readFileSync(hostKeyFile, 'utf8').trim().split(/\s+/)[1]!, 'base64');
  return createHash('sha256').update(blob).digest('hex');
}

/**
 * Connects the right pane. A fresh profile has never seen the server, so the
 * security window asks first; it must show the key the server really has.
 */
async function connectTrusting(app: RunningApp) {
  await startConnecting(app.page, server);
  const confirmation = await app.otherWindow();
  await expect(confirmation.locator('body')).toContainText(
    `Key offered now: ${hostKeyFingerprint()}`,
    { timeout: 15_000 },
  );
  await confirmation.getByRole('button', { name: 'Trust this server', exact: true }).click();
  await waitConnected(app.page);
}

async function uploadFromWorkDir(app: RunningApp, name: string) {
  await openFolder(localPane(app.page), app.workDir);
  await connectTrusting(app);
  await copyAcross(localPane(app.page), name);
}

const stagingOf = (added: string[]) => added.filter(isStaging);

test('the first connection shows the server key, and an upload over SFTP lands byte for byte', async ({
  serverRoot,
  app,
}) => {
  const bytes = payload();
  const name = uniqueName();
  writeFileSync(path.join(app.workDir, name), bytes);

  await uploadFromWorkDir(app, name);
  await expect(await settledRow(app.page, name)).toHaveAccessibleName(/: Done\b/);

  expect(serverRoot.added()).toEqual([name]);
  expect(sha256(readFileSync(path.join(server.root, name)))).toBe(sha256(bytes));
  await expect(fileRow(remotePane(app.page), name)).toBeVisible({
    timeout: 15_000,
  });
});

test.describe('with a speed limit, so a transfer is still running when it is paused or stopped', () => {
  // 3 MB at 256 KB/s takes about twelve seconds.
  test.use({ appSettings: { transferSpeedLimitKBps: 256 } });

  test('stopping an upload over an existing file keeps the old file and removes its staging file', async ({
    serverRoot,
    app,
  }) => {
    const { page } = app;
    const name = uniqueName();
    const old = payload();
    writeFileSync(path.join(server.root, name), old);
    writeFileSync(path.join(app.workDir, name), payload());

    await uploadFromWorkDir(app, name);
    await page.getByRole('dialog').getByRole('button', { name: 'Overwrite', exact: true }).click();
    const running = runningRow(page, name);
    await running.waitFor({ timeout: 30_000 });
    expect(stagingOf(serverRoot.added())).toHaveLength(1);
    await running.getByRole('button', { name: 'Stop', exact: true }).click();

    await expect(await settledRow(page, name)).toHaveAccessibleName(/: Cancelled\b/);
    // OpenSSH keeps what it received: only FTPeach can have removed it.
    await expect.poll(() => serverRoot.added(), { timeout: 15_000 }).toEqual([name]);
    expect(sha256(readFileSync(path.join(server.root, name)))).toBe(sha256(old));
  });

  test('a paused upload resumes by appending to its own staging file, never starting over', async ({
    serverRoot,
    app,
  }) => {
    const { page } = app;
    const name = uniqueName();
    const bytes = payload();
    writeFileSync(path.join(app.workDir, name), bytes);

    await uploadFromWorkDir(app, name);
    const running = runningRow(page, name);
    await running.waitFor({ timeout: 30_000 });
    await running.getByRole('button', { name: 'Pause', exact: true }).click();
    const paused = queueRow(page, name, 'Paused');
    await paused.waitFor({ timeout: 15_000 });

    // What the pause kept: one staging file with part of the upload in it.
    const kept = stagingOf(serverRoot.added());
    expect(kept).toHaveLength(1);
    const keptSize = statSync(path.join(server.root, kept[0]!)).size;
    expect(keptSize).toBeGreaterThan(0);
    expect(keptSize).toBeLessThan(bytes.length);

    // Starting over would delete it and write a staging file under a new
    // name; watch every staging name the server holds until the end.
    const seen = new Set(kept);
    const watch = setInterval(() => stagingOf(serverRoot.added()).forEach((n) => seen.add(n)), 50);
    try {
      await paused.getByRole('button', { name: 'Resume', exact: true }).click();
      await expect(await settledRow(page, name)).toHaveAccessibleName(/: Done\b/);
    } finally {
      clearInterval(watch);
    }
    expect([...seen]).toEqual(kept);
    expect(serverRoot.added()).toEqual([name]);
    expect(sha256(readFileSync(path.join(server.root, name)))).toBe(sha256(bytes));
  });
});
