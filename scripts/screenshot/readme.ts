/* global document, HTMLElement, Image */
// Retakes assets/images/ftpeach.png from the real application: three live
// connections to the Docker test servers, one upload running under a speed
// limit and one paused, framed on a transparent canvas with the window's
// border and shadow. Run it after a UI change instead of capturing by hand.
//
// The app runs from a debug build against the Vite dev server, with a
// throwaway profile, so the maintainer's own settings and bookmarks are never
// touched. The Docker baseline stack must be up (`npm run servers:up -- baseline`).
// Confirming the SSH key of the local SFTP server is left to the person running
// this: that window exists so that a person decides.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';

const root = path.resolve(import.meta.dirname, '../..');
const output = path.join(root, 'assets/images/ftpeach.png');
const app = path.join(root, 'src-tauri/target/debug/app.exe');
const cdpPort = 9333;
const ftpContainer = 'ftpeach-test-ftp';
const ftpHome = '/home/testuser';

// The folder the left pane shows, which is also the source of the uploads and
// of the files already on the server. The path is part of the picture.
const localFolder = process.argv[2] ?? 'D:\\Your\\Local\\Path';
const MiB = 1024 * 1024;
const localFiles: Record<string, number> = {
  'archive.zip': 18 * MiB,
  'audio.mp3': 4.8 * MiB,
  'code.js': 6 * 1024,
  'image.png': 245 * 1024,
  'spreadsheet.xlsx': 42 * 1024,
  'text.txt': 2 * 1024,
  'video.mp4': 128 * MiB,
};
const serverFiles = ['code.js', 'image.png', 'spreadsheet.xlsx', 'text.txt'];
const serverNames = [...serverFiles, 'Folder', 'archive.zip', 'video.mp4'];

// Positions in SITE_ICONS and SITE_COLORS (src/features/sites/siteMeta.ts).
const bookmarks = [
  { name: 'FTP', icon: 1, color: 1, protocol: 'FTP', address: '127.0.0.1', port: '2131' },
  { name: 'SFTP', icon: 16, color: 4, protocol: 'SFTP', address: '127.0.0.1', port: '2222' },
  {
    name: 'WebDAV',
    icon: 5,
    color: 6,
    protocol: 'WebDAV',
    address: 'http://127.0.0.1:6065/',
    port: '',
  },
];

// The frame measured from the original capture: margins around the window, its
// 1 px border, corner radius, and the shadow's alpha 1..62 px from the edge.
const frame = { left: 111, top: 86, right: 112, bottom: 87, radius: 11, border: 'rgb(41,38,34)' };
const shadow = [
  31, 30, 30, 30, 29, 28, 28, 27, 27, 26, 25, 25, 24, 24, 23, 22, 22, 21, 20, 19, 19, 18, 17, 16,
  16, 15, 14, 14, 13, 13, 12, 11, 11, 10, 10, 9, 8, 8, 8, 7, 7, 6, 6, 5, 5, 5, 4, 4, 4, 3, 3, 3, 2,
  2, 2, 2, 1, 1, 1, 1, 1, 1,
];

function run(command: string, args: string[], options: { capture?: boolean } = {}): string {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
  return result.stdout ?? '';
}

function inFtp(script: string, capture = false): string {
  return run('docker', ['exec', ftpContainer, 'sh', '-c', script], { capture });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  seconds: number,
): Promise<T> {
  for (let tick = 0; tick < seconds * 4; tick++) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function ensureLocalFolder() {
  mkdirSync(path.join(localFolder, 'Folder'), { recursive: true });
  for (const [name, size] of Object.entries(localFiles)) {
    const file = path.join(localFolder, name);
    if (existsSync(file)) continue;
    writeFileSync(file, '');
    truncateSync(file, Math.round(size));
    const date = new Date('2026-09-06T14:10:00');
    utimesSync(file, date, date);
  }
}

function seedServer() {
  const present = inFtp(`ls -A ${ftpHome}`, true).split(/\s+/).filter(Boolean);
  const clash = present.filter((name) => serverNames.includes(name));
  // Cleanup deletes these names, so they must not be someone else's files.
  if (clash.length > 0)
    throw new Error(`${ftpHome} already has ${clash.join(', ')}; remove them first`);
  for (const name of serverFiles) {
    run('docker', ['cp', path.join(localFolder, name), `${ftpContainer}:${ftpHome}/`]);
  }
  inFtp(
    `cd ${ftpHome} && mkdir Folder && chown -R ftpuser ${serverNames.slice(0, 5).join(' ')} && touch ${serverNames.slice(0, 5).join(' ')}`,
  );
}

function cleanServer() {
  inFtp(`cd ${ftpHome} && rm -rf ${serverNames.join(' ')} .ftpeach-*.part`);
}

async function createBookmarks(page: Page) {
  await page.getByRole('button', { name: 'Manage Bookmarks', exact: true }).click();
  for (const site of bookmarks) {
    await page.getByRole('button', { name: 'New Bookmark' }).click();
    const dialog = page.getByRole('dialog', { name: 'New Bookmark' });
    const pick = async (button: string, index: number) => {
      await dialog.getByRole('button', { name: button, exact: true }).click();
      await page.locator('.menu-items').last().locator(':scope > *').nth(index).click();
    };
    await pick('Icon', site.icon);
    await pick('Color', site.color);
    await dialog.getByRole('button', { name: 'FTP', exact: true }).click();
    await page.locator('.menu-items').last().getByText(site.protocol, { exact: true }).click();
    const fill = (label: string, value: string) =>
      dialog.getByRole('textbox', { name: label, exact: true }).fill(value);
    await fill('Name', site.name);
    await fill('Address', site.address);
    if (site.port) await fill('Port', site.port);
    await fill('Username', 'testuser');
    await fill('Password', 'testpass');
    if (site.protocol === 'WebDAV') {
      await dialog.getByText('Advanced settings').click();
      await dialog.getByRole('checkbox', { name: 'Allow unencrypted sign-in' }).check();
    }
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
}

async function openBookmark(page: Page, name: string, newTab: boolean) {
  if (newTab) {
    await page.getByText('+', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Manage Bookmarks', exact: true }).click();
  }
  await page
    .getByRole('dialog', { name: 'Manage Bookmarks' })
    .getByText(name, { exact: true })
    .dblclick();
}

// The log keeps only its visible lines in the page, so a connection is judged
// by the pane: it offers Disconnect and lists the server.
async function connected(page: Page, entry: string, seconds: number) {
  const pane = page.locator('.pane[data-side=b]');
  await pane.getByRole('button', { name: 'Disconnect' }).waitFor({ timeout: seconds * 1000 });
  if (entry) await pane.locator('.pane-list').getByText(entry, { exact: true }).waitFor();
}

async function progress(page: Page, name: string): Promise<number> {
  const row = await page
    .locator('.transfer-item', { hasText: name })
    .innerText()
    .catch(() => '');
  return Number(/(\d+)%/.exec(row)?.[1] ?? 0);
}

async function stage(page: Page, profile: string) {
  await page.getByRole('button', { name: 'Show/hide log' }).click();
  await createBookmarks(page);

  await openBookmark(page, 'FTP', false);
  await connected(page, 'text.txt', 20);

  await openBookmark(page, 'SFTP', true);
  console.log('Confirm the key of the local SFTP test server in the FTPeach window that opened.');
  const knownHosts = path.join(profile, 'Roaming/FTPeach/known_hosts.json');
  await waitFor(
    'the SFTP key to be trusted',
    async () => (await readFile(knownHosts, 'utf8').catch(() => '')).includes('2222') || undefined,
    300,
  );
  // The reconnect after trusting a key can come back without the saved password.
  await connected(page, 'upload', 5).catch(() =>
    page
      .locator('.pane[data-side=b]')
      .getByRole('button', { name: 'Connect', exact: true })
      .click(),
  );
  await connected(page, 'upload', 20);

  await openBookmark(page, 'WebDAV', true);
  await connected(page, '', 20);

  await page.locator('.tab-strip-item').first().click();
  await page.keyboard.press('Control+,');
  const settings = page.locator('.modal').last();
  await settings.getByText('Transfers', { exact: true }).click();
  await settings.getByLabel('Speed limit, KB/s').fill('100');
  await settings.getByRole('button', { name: 'Save' }).click();
  await settings.waitFor({ state: 'hidden' });

  const left = page.locator('.pane[data-side=a]');
  const bar = left.locator('.pane-path:not(.pane-path-measure)');
  const box = (await bar.boundingBox())!;
  await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2);
  await left.locator('.path-input').fill(localFolder);
  await left.locator('.path-input').press('Enter');
  const list = left.locator('.pane-list');
  await list.getByText('video.mp4', { exact: true }).waitFor();

  // The newest transfer is listed first, so the paused one is started first.
  const copy = left.getByRole('button', { name: 'Copy to pane on the right' });
  await list.getByText('video.mp4', { exact: true }).click();
  await copy.click();
  await waitFor(
    'video.mp4 to reach 1%',
    async () => (await progress(page, 'video.mp4')) >= 1 || undefined,
    60,
  );
  await page.getByRole('button', { name: 'Pause active transfers' }).click();
  await list.getByText('archive.zip', { exact: true }).click();
  await copy.click();
  await list.getByText('archive.zip', { exact: true }).click({ modifiers: ['Control'] });
  await waitFor(
    'archive.zip to reach 22%',
    async () => (await progress(page, 'archive.zip')) >= 22 || undefined,
    120,
  );
  // Two listings put the server's replies in the log instead of the sign-in.
  const refresh = page.getByRole('button', { name: 'Refresh both panes (F5)' });
  await refresh.click();
  await page.waitForTimeout(1000);
  await refresh.click();
  await page.waitForTimeout(1000);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(1000, 420);
  await page.waitForTimeout(500);
}

/** Draws the window capture onto the transparent canvas with border and shadow. */
async function compose(capture: Buffer): Promise<Buffer> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const png = await page.evaluate(
      async ({ src, frame, shadow }) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        const w = image.width + 2;
        const h = image.height + 2;
        const width = frame.left + w + frame.right;
        const height = frame.top + h + frame.bottom;
        const canvas = Object.assign(document.createElement('canvas'), { width, height });
        const ctx = canvas.getContext('2d')!;
        const pixels = ctx.createImageData(width, height);
        const r = frame.radius;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const qx = Math.max(frame.left + r - x - 0.5, x + 0.5 - (frame.left + w - r), 0);
            const qy = Math.max(frame.top + r - y - 0.5, y + 0.5 - (frame.top + h - r), 0);
            // The table counts whole pixels from the edge, starting at 1.
            const d = Math.hypot(qx, qy) - r + 0.5;
            if (d <= 0.5) continue;
            const i = Math.floor(d);
            const near = shadow[Math.max(i - 1, 0)] ?? 0;
            const far = shadow[i] ?? 0;
            pixels.data[(y * width + x) * 4 + 3] = Math.round(near + (far - near) * (d - i));
          }
        }
        ctx.putImageData(pixels, 0, 0);
        ctx.fillStyle = frame.border;
        ctx.beginPath();
        ctx.roundRect(frame.left, frame.top, w, h, r);
        ctx.fill();
        ctx.beginPath();
        ctx.roundRect(frame.left + 1, frame.top + 1, w - 2, h - 2, r - 1);
        ctx.clip();
        ctx.drawImage(image, frame.left + 1, frame.top + 1);
        return canvas.toDataURL('image/png');
      },
      { src: `data:image/png;base64,${capture.toString('base64')}`, frame, shadow },
    );
    return Buffer.from(png.split(',')[1]!, 'base64');
  } finally {
    await browser.close();
  }
}

function stop(child: ChildProcess | undefined) {
  if (child?.pid && child.exitCode === null) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
}

if (!(await portOpen(2131)) || !(await portOpen(2222)) || !(await portOpen(6065))) {
  throw new Error('The Docker test servers are not running: npm run servers:up -- baseline');
}
// A running FTPeach would take the launch over as its single instance.
const running = spawnSync('tasklist', ['/FI', 'IMAGENAME eq FTPeach.exe'], {
  encoding: 'utf8',
}).stdout;
if (running.includes('FTPeach.exe')) throw new Error('Close FTPeach first');
if (await portOpen(5173)) throw new Error('Port 5173 is in use; stop the running dev server first');

// What `npm run rust:build` runs, without a shell in between.
run('powershell', [
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  'scripts/with-libsodium.ps1',
  '-Command',
  'cargo-build',
]);
ensureLocalFolder();
seedServer();

const profile = mkdtempSync(path.join(tmpdir(), 'ftpeach-screenshot-'));
let vite: ChildProcess | undefined;
let ftpeach: ChildProcess | undefined;
try {
  vite = spawn('npm run dev:renderer', { cwd: root, shell: true, stdio: 'ignore' });
  await waitFor('Vite', async () => (await portOpen(5173)) || undefined, 60);
  ftpeach = spawn(app, [], {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      APPDATA: path.join(profile, 'Roaming'),
      LOCALAPPDATA: path.join(profile, 'Local'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    },
  });
  await waitFor('the app', async () => (await portOpen(cdpPort)) || undefined, 60);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const page = await waitFor('the main window', async () => browser.contexts()[0]?.pages()[0], 30);
  await page.getByRole('button', { name: 'Manage Bookmarks', exact: true }).waitFor();
  await stage(page, profile);
  writeFileSync(output, await compose(await page.screenshot()));
  console.log(`Saved ${path.relative(root, output)}. Look at it before committing.`);
  await page.getByRole('button', { name: 'Stop active transfers' }).click();
  await browser.close();
} finally {
  stop(ftpeach);
  stop(vite);
  cleanServer();
  rmSync(profile, { recursive: true, force: true });
}
