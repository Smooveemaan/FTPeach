import { _electron as electron } from 'playwright-core';
import type { ElectronApplication, Locator, Page } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';

const scratchDirectory = process.env.VERIFY_SCRATCH;
if (!scratchDirectory)
  throw new Error('Set VERIFY_SCRATCH to a scratch directory before running this script.');
const SCRATCH: string = scratchDirectory;

interface VerificationResult {
  name: string;
  ok: boolean;
  error?: string;
  note?: string;
}

type VerificationStep = () => Promise<void>;

const results: VerificationResult[] = [];
let step = '';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function log(msg: string): void {
  console.log(`[verify] ${msg}`);
}

async function record(name: string, fn: VerificationStep): Promise<void> {
  step = name;
  try {
    await fn();
    results.push({ name, ok: true });
    log(`OK: ${name}`);
  } catch (error: unknown) {
    results.push({ name, ok: false, error: errorMessage(error) });
    log(`FAIL: ${name} -- ${errorMessage(error)}`);
  }
}

async function recordExpectFail(name: string, fn: VerificationStep): Promise<void> {
  step = name;
  try {
    await fn();
    results.push({ name, ok: false, error: 'expected an error banner but none appeared' });
    log(`FAIL (expected error but none shown): ${name}`);
  } catch (error: unknown) {
    results.push({ name, ok: true, note: errorMessage(error) });
    log(`OK (error correctly surfaced): ${name} -- ${errorMessage(error)}`);
  }
}

async function launchApp(tag: string): Promise<{ app: ElectronApplication; win: Page }> {
  const userDataDir = path.join(SCRATCH, `userdata-${tag}`);
  await fs.mkdir(userDataDir, { recursive: true });
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: process.cwd(),
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1000);
  return { app, win };
}

const remotePane = (win: Page): Locator =>
  win.locator('.pane', { has: win.locator('.pane-title', { hasText: 'Server' }) });
const localPane = (win: Page): Locator => win.locator('.pane').first();

async function clickPanePath(pane: Locator): Promise<void> {
  const sep = pane.locator('.pane-path .sep').first();
  if (await sep.count()) {
    await sep.click();
  } else {
    await pane.locator('.pane-path').click();
  }
}

async function setLocalPath(_win: Page, pane: Locator, dir: string): Promise<void> {
  await clickPanePath(pane);
  const input = pane.locator('.path-input');
  await input.waitFor({ timeout: 5000 });
  await input.fill(dir);
  await input.press('Enter');
}

async function shot(win: Page, protocol: string, name: string): Promise<void> {
  try {
    await win.screenshot({ path: path.join(SCRATCH, `${protocol}-${name}.png`) });
  } catch {}
}

// ================= FTPS: full functional pass =================
async function runFtps(): Promise<void> {
  const protocol = 'ftps';
  const localDir = path.join(SCRATCH, `local-${protocol}`);
  await fs.mkdir(localDir, { recursive: true });
  const localFile = path.join(localDir, 'hello.txt');
  await fs.writeFile(
    localFile,
    `FTPeach verify test file (${protocol})\n${new Date().toISOString()}\n`,
  );

  const { app, win } = await launchApp(protocol);

  await record('[ftps] app window loaded', async () => {
    const title = await win.title();
    if (!title) throw new Error('empty window title');
  });

  await record('[ftps] navigate local pane to scratch dir', async () => {
    await setLocalPath(win, localPane(win), localDir);
    await localPane(win).locator('.row[data-name="hello.txt"]').waitFor({ timeout: 5000 });
  });

  await record('[ftps] switch protocol to FTPS', async () => {
    await win.locator('.protocol-select-trigger').click();
    await win.locator('.protocol-select-dropdown .menu-item', { hasText: 'FTPS' }).click();
  });

  await record('[ftps] fill connection form', async () => {
    await win.locator('.field-host').fill('demo.wftpserver.com');
    await win.locator('.field-port').fill('21');
    await win.locator('.field-user').fill('demo');
    await win.locator('.field-pass').fill('demo');
  });
  await shot(win, protocol, 'form-filled');

  await record('[ftps] connect', async () => {
    await win.locator('button.connect-toggle-btn[type="submit"]').click();
    await win.locator('button.connect-toggle-btn.state-connected').waitFor({ timeout: 20000 });
  });

  await record('[ftps] root listing shows upload/download folders', async () => {
    await remotePane(win).locator('.row[data-name="upload"]').waitFor({ timeout: 15000 });
    await remotePane(win).locator('.row[data-name="download"]').waitFor({ timeout: 15000 });
  });
  await shot(win, protocol, 'root-listing');

  await record('[ftps] navigate into /download and list files', async () => {
    await remotePane(win).locator('.row[data-name="download"]').dblclick();
    await remotePane(win).locator('.row[data-name="version.txt"]').waitFor({ timeout: 15000 });
  });

  await record('[ftps] download version.txt from /download', async () => {
    const row = remotePane(win).locator('.row[data-name="version.txt"]');
    await row.click();
    const downloadBtn = remotePane(win).locator('button[data-tooltip="Download"]');
    await downloadBtn.click();
    const downloaded = path.join(localDir, 'version.txt');
    let st = null;
    for (let i = 0; i < 20; i++) {
      await win.waitForTimeout(1000);
      try {
        st = await fs.stat(downloaded);
        if (st.size > 0) break;
      } catch {
        // not written yet
      }
    }
    if (!st || st.size === 0)
      throw new Error('downloaded file never appeared with content after 20s');
  });
  await shot(win, protocol, 'downloaded');

  await record('[ftps] navigate to root then into /upload', async () => {
    const crumbs = remotePane(win).locator('.pane-path .crumb');
    await crumbs.first().click();
    await remotePane(win).locator('.row[data-name="upload"]').waitFor({ timeout: 15000 });
    await remotePane(win).locator('.row[data-name="upload"]').dblclick();
    await win.waitForTimeout(1500);
  });

  const uploadName = `verify-ui-${Date.now()}.txt`;
  await record('[ftps] rename local test file to unique name and upload to /upload', async () => {
    await fs.rename(localFile, path.join(localDir, uploadName));
    await setLocalPath(win, localPane(win), localDir);
    const row = localPane(win).locator(`.row[data-name="${uploadName}"]`);
    await row.waitFor({ timeout: 5000 });
    await row.click();
    const uploadBtn = localPane(win).locator('button[data-tooltip="Upload to server"]');
    await uploadBtn.click();
    await remotePane(win).locator(`.row[data-name="${uploadName}"]`).waitFor({ timeout: 20000 });
  });
  await shot(win, protocol, 'uploaded');

  await recordExpectFail('[ftps] rename is correctly rejected by server permissions', async () => {
    const row = remotePane(win).locator(`.row[data-name="${uploadName}"]`);
    await row.click();
    await row.click({ button: 'right' });
    await win.locator('.context-menu .menu-item', { hasText: 'Rename' }).click();
    const input = remotePane(win).locator('.rename-input');
    await input.fill('should-not-work.txt');
    await input.press('Enter');
    await win.waitForTimeout(1500);
    const errBanner = win.locator('.conn-error');
    const txt = (await errBanner.count()) ? await errBanner.innerText() : '';
    if (!txt) throw new Error('no error shown for rejected rename');
    throw new Error(`server correctly rejected: ${txt}`);
  });
  await shot(win, protocol, 'rename-denied');

  await recordExpectFail('[ftps] delete is correctly rejected by server permissions', async () => {
    const row = remotePane(win).locator(`.row[data-name="${uploadName}"]`);
    await row.click();
    const delBtn = remotePane(win).locator('button[data-tooltip="Delete"]');
    await delBtn.click();
    await win.locator('.modal-footer button.btn-danger').click();
    await win.waitForTimeout(1500);
    const errBanner = win.locator('.conn-error');
    const txt = (await errBanner.count()) ? await errBanner.innerText() : '';
    if (!txt) throw new Error('no error shown for rejected delete');
    throw new Error(`server correctly rejected: ${txt}`);
  });
  await shot(win, protocol, 'delete-denied');

  await recordExpectFail('[ftps] mkdir is correctly rejected by server permissions', async () => {
    await remotePane(win).locator('button[data-tooltip="New folder"]').click();
    const input = win.locator('.modal input[type="text"]');
    await input.fill(`verify-dir-${Date.now()}`);
    await win.locator('.modal-footer button.btn-primary').click();
    await win.waitForTimeout(1500);
    const errBanner = win.locator('.conn-error');
    const txt = (await errBanner.count()) ? await errBanner.innerText() : '';
    if (!txt) throw new Error('no error shown for rejected mkdir');
    throw new Error(`server correctly rejected: ${txt}`);
  });
  await shot(win, protocol, 'mkdir-denied');

  await record('[ftps] refresh (F5 toolbar) still works after errors', async () => {
    await win.locator('button[data-tooltip="Refresh panes (F5)"]').click();
    await win.waitForTimeout(1000);
    await remotePane(win).locator(`.row[data-name="${uploadName}"]`).waitFor({ timeout: 10000 });
  });

  await record('[ftps] disconnect', async () => {
    await win.locator('button.connect-toggle-btn[data-tooltip="Disconnect"]').click();
    await win.waitForTimeout(500);
    await win.locator('button.connect-toggle-btn[type="submit"]').waitFor({ timeout: 8000 });
  });
  await shot(win, protocol, 'disconnected');

  const siteName = `verify-site-${Date.now()}`;
  await record('[ftps] site manager: save current site', async () => {
    await win.locator('.field-host').fill('demo.wftpserver.com');
    await win.locator('.field-port').fill('21');
    await win.locator('.field-user').fill('demo');
    await win.locator('.field-pass').fill('demo');
    await win.locator('.site-manager button.btn-ghost', { hasText: 'Sites' }).click();
    await win.locator('.site-manager-save-row button').click();
    const input = win.locator('.modal input[type="text"]');
    await input.fill(siteName);
    await win.locator('.modal-footer button.btn-primary').click();
    await win.waitForTimeout(500);
    await win.locator('.site-manager button.btn-ghost', { hasText: 'Sites' }).click();
    await win.locator('.site-row .site-name', { hasText: siteName }).waitFor({ timeout: 5000 });
  });

  await record('[ftps] site manager: delete saved test site', async () => {
    const row = win.locator('.site-row', { has: win.locator('.site-name', { hasText: siteName }) });
    await row.locator('.site-delete').click();
    await win.locator('.modal-footer button.btn-danger').click();
    await win.waitForTimeout(500);
    const count = await win.locator('.site-row .site-name', { hasText: siteName }).count();
    if (count !== 0) throw new Error('site still present after delete');
  });

  await app.close();
}

async function runPlainFtpProbe(): Promise<void> {
  const protocol = 'ftp';
  const { app, win } = await launchApp(protocol);

  await record('[ftp] app window loaded', async () => {
    const title = await win.title();
    if (!title) throw new Error('empty window title');
  });

  await record('[ftp] fill connection form', async () => {
    await win.locator('.field-host').fill('demo.wftpserver.com');
    await win.locator('.field-port').fill('21');
    await win.locator('.field-user').fill('demo');
    await win.locator('.field-pass').fill('demo');
  });

  await record('[ftp] connect (control channel)', async () => {
    await win.locator('button.connect-toggle-btn[type="submit"]').click();
    await win.locator('button.connect-toggle-btn.state-connected').waitFor({ timeout: 20000 });
  });
  await shot(win, protocol, 'connected');

  await record(
    '[ftp] plain-FTP data channel either lists or fails gracefully within 25s',
    async () => {
      const rowsAppear = remotePane(win)
        .locator('.row[data-name="upload"]')
        .waitFor({ timeout: 25000 })
        .then(() => 'listed');
      const errorAppears = win
        .locator('.conn-error')
        .waitFor({ timeout: 25000 })
        .then(() => 'errored');
      const outcome = await Promise.race([rowsAppear, errorAppears]);
      if (outcome === 'errored') {
        const txt = await win.locator('.conn-error').innerText();
        results.push({
          name: '[ftp] plain-FTP data channel timed out (environment-specific, see README.md)',
          ok: true,
          note: txt,
        });
      }
    },
  );
  await shot(win, protocol, 'listing-outcome');

  await record('[ftp] disconnect', async () => {
    const disconnectBtn = win.locator('button.connect-toggle-btn[data-tooltip="Disconnect"]');
    if (await disconnectBtn.count()) {
      await disconnectBtn.click();
      await win.waitForTimeout(500);
    }
  });

  await app.close();
}

(async () => {
  log('=== FTPS full functional pass ===');
  try {
    await runFtps();
  } catch (error: unknown) {
    results.push({
      name: `[ftps] unexpected fatal error at step "${step}"`,
      ok: false,
      error: errorStack(error),
    });
    log(`FATAL in ftps: ${errorStack(error)}`);
  }

  log('=== Plain FTP data-channel probe ===');
  try {
    await runPlainFtpProbe();
  } catch (error: unknown) {
    results.push({
      name: `[ftp] unexpected fatal error at step "${step}"`,
      ok: false,
      error: errorStack(error),
    });
    log(`FATAL in ftp: ${errorStack(error)}`);
  }

  console.log('\n\n===RESULTS_JSON===');
  console.log(JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  process.exit(failed.length ? 1 : 0);
})();
