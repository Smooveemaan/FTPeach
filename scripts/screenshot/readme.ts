/* global document, HTMLElement, Image, MouseEvent, window */
// Retakes assets/images/ftpeach.png and ftpeach-light.png, which the landing
// page shows in its dark and light theme, from the real application: three live
// connections to the Docker test servers, one upload running under a speed
// limit and one paused, framed on a transparent canvas with the window's
// border and shadow. Run it after a UI change instead of capturing by hand.
//
// The app runs from a debug build against the Vite dev server, with a
// throwaway profile, so the maintainer's own settings and bookmarks are never
// touched. The Docker baseline stack must be up (`npm run servers:up -- baseline`).
// It runs without a person: the SFTP tab in the picture shows only its name and
// icon, so it signs in to the WebDAV server and no SSH key needs confirming.
//
// Both pictures are of one moment: the page's JavaScript is paused in the
// debugger, so no progress moves, while the theme is switched between them.
//
// With --video it records assets/images/ftpeach.mp4 instead (with --light, the
// app in its light theme and ftpeach-light.mp4): a
// click on the FTP bookmark, two files dragged from the left pane to the right
// and their uploads finishing, with a drawn cursor, since a screencast has
// none. There is no SFTP key to confirm. The window is moved to a monitor at
// 200% when there is one: a screencast gets the window's own pixels and
// ignores an emulated scale factor. Needs ffmpeg on PATH.
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
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';

const root = path.resolve(import.meta.dirname, '../..');
const light = process.argv.includes('--light');
const video = process.argv.includes('--video');
const output = (theme: 'dark' | 'light', type: 'png' | 'mp4') =>
  path.join(root, `assets/images/ftpeach${theme === 'light' ? '-light' : ''}.${type}`);
const app = path.join(root, 'src-tauri/target/debug/app.exe');
const cdpPort = 9333;
const ftpContainer = 'ftpeach-test-ftp';
const sftpContainer = 'ftpeach-test-sftp';
const ftpHome = '/home/testuser';

// The folder the left pane shows, which is also the source of the uploads and
// of the files already on the server. The path is part of the picture.
const localFolder =
  process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'D:\\Your\\Local\\Path';
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
const serverNames = [...serverFiles, 'Folder', 'archive.zip', 'video.mp4', 'audio.mp3'];

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

// The window is captured at twice its CSS size whatever the monitor's scaling,
// so the picture stays sharp on high-density screens and halves cleanly on others.
const pixelRatio = 2;
// The frame measured from a capture at 125%: margins around the window, its
// 1 px border (the theme's --window-border), corner radius, and the shadow's
// alpha 1..62 px from the edge. Scaled from there to pixelRatio.
const measuredAt = 1.25;
const k = pixelRatio / measuredAt;
const frame = {
  left: Math.round(111 * k),
  top: Math.round(86 * k),
  right: Math.round(112 * k),
  bottom: Math.round(87 * k),
  radius: Math.round(11 * k),
  border: Math.round(k),
  borderColor: { dark: 'rgb(41,38,34)', light: 'rgb(201,195,188)' },
  shadowScale: k,
};
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
  const seeded = [...serverFiles, 'Folder'].join(' ');
  inFtp(`cd ${ftpHome} && mkdir Folder && chown -R ftpuser ${seeded} && touch ${seeded}`);
}

/**
 * The video's bookmark list names each protocol, so its SFTP tab is real. The
 * key the app would ask about is pinned in the throwaway profile beforehand,
 * read from the test server's own container, in the trust store's format: the
 * SHA-256 of the key's SSH encoding, in hex.
 */
function trustSftpServer() {
  const key = run('docker', ['exec', sftpContainer, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'], {
    capture: true,
  });
  const fingerprint = createHash('sha256')
    .update(Buffer.from(key.split(' ')[1]!, 'base64'))
    .digest('hex');
  const dir = path.join(profile, 'Roaming/FTPeach');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'known_hosts.json'),
    JSON.stringify({ schemaVersion: 1, data: { '127.0.0.1:2222': fingerprint } }),
  );
}

function cleanServer() {
  inFtp(`cd ${ftpHome} && rm -rf ${serverNames.join(' ')} .ftpeach-*.part`);
}

async function createBookmarks(page: Page, sites = bookmarks) {
  await page.getByRole('button', { name: 'Manage Bookmarks', exact: true }).click();
  for (const [i, site] of sites.entries()) {
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
    // A second bookmark for the same server is confirmed.
    const same = (other: (typeof sites)[number]) =>
      other.protocol === site.protocol &&
      other.address === site.address &&
      other.port === site.port;
    if (sites.slice(0, i).some(same)) {
      await page.getByRole('button', { name: 'Save anyway' }).click();
    }
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

async function stage(page: Page) {
  await page.getByRole('button', { name: 'Show/hide log' }).click();
  // The SFTP tab is seen only by its name and icon, so it goes to the WebDAV
  // server: no SSH key to confirm, and pure-ftpd's five connections per
  // address stay with the FTP tab. The video lists bookmarks with their
  // protocol and keeps the real one.
  const webdav = bookmarks.find((site) => site.name === 'WebDAV')!;
  await createBookmarks(
    page,
    bookmarks.map((site) =>
      site.name === 'SFTP'
        ? { ...webdav, name: site.name, icon: site.icon, color: site.color }
        : site,
    ),
  );

  await openBookmark(page, 'FTP', false);
  await connected(page, 'text.txt', 20);

  await openBookmark(page, 'SFTP', true);
  await connected(page, '', 20);

  await openBookmark(page, 'WebDAV', true);
  await connected(page, '', 20);

  await page.locator('.tab-strip-item').first().click();
  await applySettings(page, '2000');
  await openLocalFolder(page);
  const left = page.locator('.pane[data-side=a]');
  const list = left.locator('.pane-list');

  // The newest transfer is listed first, so the paused one is started first.
  const copy = left.getByRole('button', { name: 'Copy to pane on the right' });
  await list.getByText('archive.zip', { exact: true }).click();
  await copy.click();
  await waitFor(
    'archive.zip to reach 1%',
    async () => (await progress(page, 'archive.zip')) >= 1 || undefined,
    60,
  );
  await page.getByRole('button', { name: 'Pause active transfers' }).click();
  await list.getByText('video.mp4', { exact: true }).click();
  await copy.click();
  await list.getByText('video.mp4', { exact: true }).click({ modifiers: ['Control'] });
  // Most of the way at ten times the speed, then the pictured 2000 KB/s until
  // the shown speed, an average, has come down to it.
  await applySettings(page, '20000');
  await waitFor(
    'video.mp4 to reach 36%',
    async () => (await progress(page, 'video.mp4')) >= 36 || undefined,
    60,
  );
  await applySettings(page, '2000');
  await waitFor(
    'video.mp4 to reach 46% at 1.9 MB/s',
    async () => {
      const row = await page.locator('.transfer-item', { hasText: 'video.mp4' }).innerText();
      const speed = Number(/([\d.]+) MB\/s/.exec(row)?.[1] ?? Infinity);
      return ((await progress(page, 'video.mp4')) >= 46 && speed <= 2) || undefined;
    },
    60,
  );
  // Two listings put the server's replies in the log instead of the sign-in.
  const refresh = page.getByRole('button', { name: 'Refresh both panes (F5)' });
  await refresh.click();
  await page.waitForTimeout(400);
  await refresh.click();
  await page.waitForTimeout(400);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(1000, 420);
  await page.waitForTimeout(200);
}

/** Sets the speed limit (KB/s) and, with --light, the light theme. */
async function applySettings(page: Page, speedLimit: string) {
  await page.keyboard.press('Control+,');
  const settings = page.locator('.modal').last();
  await settings.getByText('Transfers', { exact: true }).click();
  await settings.getByLabel('Speed limit, KB/s').fill(speedLimit);
  if (light) {
    await settings.getByText('Interface', { exact: true }).click();
    // The <label> around the theme switch names its first radio after the
    // whole label, so the option is found by its text.
    await settings
      .locator('.settings-segmented')
      .first()
      .getByText('Light', { exact: true })
      .click();
  }
  await settings.getByRole('button', { name: 'Save' }).click();
  await settings.waitFor({ state: 'hidden' });
}

async function openLocalFolder(page: Page) {
  const left = page.locator('.pane[data-side=a]');
  const bar = left.locator('.pane-path:not(.pane-path-measure)');
  const box = (await bar.boundingBox())!;
  await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2);
  await left.locator('.path-input').fill(localFolder);
  await left.locator('.path-input').press('Enter');
  await left.locator('.pane-list').getByText('video.mp4', { exact: true }).waitFor();
  // The pane opens on the user's own home folder; nothing of it may be captured.
  const shown = (await bar.innerText()).split('/').map((part) => part.trim());
  const wanted = localFolder.split(/[\\/]/).filter(Boolean).slice(1);
  if (shown.slice(-wanted.length).join('/') !== wanted.join('/')) {
    throw new Error(`The left pane shows ${shown.join('/')}, not ${localFolder}; stopping`);
  }
}

// The video's cursor: where it is, and a glide that eases in and out over a
// fixed time, so its pace does not depend on how fast the CDP round trips are.
let cursor = { x: 0, y: 0 };

async function glide(page: Page, x: number, y: number, ms: number) {
  const from = cursor;
  const start = Date.now();
  for (let t = 0; t < 1;) {
    t = Math.min(1, (Date.now() - start) / ms);
    const e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await page.waitForTimeout(8);
  }
  cursor = { x, y };
}

async function center(selector: ReturnType<Page['locator']>) {
  const box = (await selector.boundingBox())!;
  return { x: box.x + Math.min(box.width / 2, 60), y: box.y + box.height / 2 };
}

async function click(page: Page) {
  await page.mouse.down();
  await page.waitForTimeout(90);
  await page.mouse.up();
}

/** Draws an arrow cursor that follows the mouse and dips on a press. */
async function drawCursor(page: Page) {
  await page.evaluate(() => {
    const arrow = document.createElement('div');
    arrow.innerHTML =
      '<svg width="15" height="22" viewBox="0 0 15 22"><path d="M1.5 1.5v16.2l4.1-3.9 2.8 6.4 2.7-1.2-2.7-6.3h5.6Z" fill="#fff" stroke="#000" stroke-width="1.1" stroke-linejoin="round"/></svg>';
    Object.assign(arrow.style, {
      position: 'fixed',
      left: '-1px',
      top: '-1px',
      zIndex: '2147483647',
      pointerEvents: 'none',
      transformOrigin: '1.5px 1.5px',
      transition: 'scale 90ms',
      filter: 'drop-shadow(0 1px 1.5px rgb(0 0 0 / 0.35))',
    });
    document.body.append(arrow);
    const follow = (e: MouseEvent) => {
      arrow.style.translate = `${e.clientX}px ${e.clientY}px`;
    };
    window.addEventListener('mousemove', follow, true);
    window.addEventListener('mousedown', (e) => (follow(e), (arrow.style.scale = '0.85')), true);
    window.addEventListener('mouseup', () => (arrow.style.scale = '1'), true);
  });
}

async function stageVideo(page: Page) {
  await createBookmarks(page);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Manage Bookmarks' }).waitFor({ state: 'hidden' });
  // The two uploads, 23 MB in all, take about five seconds at this.
  await applySettings(page, '5000');
  // Two more tabs, connected before the recording, as in the screenshot; the
  // recording stays in the first, which becomes the FTP tab.
  await openBookmark(page, 'SFTP', true);
  await connected(page, 'upload', 20);
  await openBookmark(page, 'WebDAV', true);
  await connected(page, '', 20);
  await page.locator('.tab-strip-item').first().click();
  // The bookmark list puts the latest connection first and reorders on a
  // click, which would move FTP from under the cursor. One connection before
  // the recording puts it first already.
  const right = page.locator('.pane[data-side=b]');
  await right
    .locator('.pane-quicklist-row')
    .filter({ has: page.locator('.pane-quicklist-name', { hasText: /^FTP$/ }) })
    .click();
  await connected(page, 'text.txt', 20);
  await right.getByRole('button', { name: 'Disconnect' }).click();
  await right.locator('.pane-quicklist-row').first().waitFor();
  await openLocalFolder(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await drawCursor(page);
  // At rest the cursor sits low in the right pane, empty before the
  // connection and after it, away from the bookmarks and Transfers.
  const pane = (await page.locator('.pane[data-side=b]').boundingBox())!;
  cursor = {
    x: Math.round(pane.x + pane.width * 0.7),
    y: Math.round(pane.y + pane.height - 60),
  };
  await page.mouse.move(cursor.x, cursor.y);
  await page.waitForTimeout(500);
}

/**
 * The video, about 16 s, in the first of three tabs: a still start, a click on the FTP bookmark, two
 * files selected with a rectangle and dragged across, their uploads finishing, the cursor
 * moving off, and the last second fading back into the first frame.
 */
async function playVideo(page: Page) {
  const left = page.locator('.pane[data-side=a] .pane-list');
  const right = page.locator('.pane[data-side=b]');
  const rest = cursor;
  await page.waitForTimeout(1500);

  const bookmark = right
    .locator('.pane-quicklist-row')
    .filter({ has: page.locator('.pane-quicklist-name', { hasText: /^FTP$/ }) });
  const at = await center(bookmark);
  await glide(page, at.x, at.y, 900);
  await page.waitForTimeout(250);
  await click(page);
  await connected(page, 'text.txt', 20);
  await page.waitForTimeout(700);

  // A selection rectangle from the empty space right of audio.mp3 up over
  // archive.zip; a press on a row would drag it instead.
  const row = (name: string) =>
    left.locator('.row', { has: page.getByText(name, { exact: true }) }).boundingBox();
  const archive = (await row('archive.zip'))!;
  const audio = (await row('audio.mp3'))!;
  const start = { x: audio.x + audio.width + 40, y: audio.y + audio.height * 0.75 };
  await glide(page, start.x, start.y, 700);
  await page.waitForTimeout(200);
  await page.mouse.down();
  await glide(page, archive.x + archive.width * 0.3, archive.y + archive.height * 0.3, 800);
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.getByText('(2 selected)').waitFor({ timeout: 2000 });
  await page.waitForTimeout(350);

  const grab = await center(left.getByText('audio.mp3', { exact: true }));
  await glide(page, grab.x, grab.y, 450);
  await page.waitForTimeout(150);
  const list = (await right.locator('.pane-list').boundingBox())!;
  await page.mouse.down();
  await glide(page, list.x + list.width * 0.45, list.y + list.height * 0.72, 1300);
  await page.waitForTimeout(450);
  await page.mouse.up();

  const uploaded = right.locator('.pane-list');
  for (const name of ['archive.zip', 'audio.mp3']) {
    await uploaded.getByText(name, { exact: true }).waitFor({ timeout: 60_000 });
  }
  await page.getByText('Transfers: 0').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
  await glide(page, rest.x, rest.y, 900);
  // A second still, then the second the fade back takes.
  await page.waitForTimeout(2000);
}

/**
 * Moves the window to a monitor at 200%, where its CSS size maps to twice as
 * many pixels. Leaves it where it is when no monitor is at 200%.
 */
function moveToDoubleScaleMonitor(pid: number): boolean {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(P p, uint f);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr m, int t, out uint x, out uint y);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
}
'@
[W]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null
$h = (Get-Process -Id ${pid}).MainWindowHandle
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  $p = New-Object W+P; $p.X = $s.Bounds.X + 10; $p.Y = $s.Bounds.Y + 10
  $x = 0; $y = 0; [W]::GetDpiForMonitor([W]::MonitorFromPoint($p, 2), 0, [ref]$x, [ref]$y) | Out-Null
  if ($x -eq 192) {
    $a = $s.WorkingArea
    [W]::SetWindowPos($h, [IntPtr]::Zero, $a.X + 40, $a.Y + 40, 0, 0, 0x15) | Out-Null
    'moved'; exit
  }
}`;
  return run('powershell', ['-NoProfile', '-Command', script], { capture: true }).includes('moved');
}

/** Records the page while `act` runs; returns frame files and their durations in seconds. */
async function record(page: Page, dir: string, act: () => Promise<void>) {
  mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const files: string[] = [];
  const times: number[] = [];
  cdp.on('Page.screencastFrame', (frame) => {
    const file = path.join(dir, `${String(files.length).padStart(5, '0')}.png`);
    writeFileSync(file, Buffer.from(frame.data, 'base64'));
    files.push(file);
    times.push(frame.metadata.timestamp ?? Date.now() / 1000);
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'png' });
  await act();
  await cdp.send('Page.stopScreencast');
  await cdp.detach();
  // A frame lasts until the next one; the last one until the recording stopped.
  times.push(Date.now() / 1000);
  const durations = files.map((_, i) => Math.max(0.001, times[i + 1]! - times[i]!));
  return { files, durations };
}

/**
 * Joins the frames into an H.264 loop whose last second fades back into the
 * first frame, and saves that frame beside it as the poster a page shows
 * until the video plays.
 */
function encode(files: string[], durations: number[], dir: string) {
  const list = path.join(dir, 'frames.txt');
  const entry = (file: string) => `file '${file.replaceAll('\\', '/')}'`;
  writeFileSync(
    list,
    files.map((file, i) => `${entry(file)}\nduration ${durations[i]!.toFixed(4)}`).join('\n') +
      `\n${entry(files.at(-1)!)}\n`,
  );
  const fade = 1;
  const total = durations.reduce((sum, d) => sum + d, 0);
  // H.264 in 4:2:0 needs even sides; the window can be a pixel over.
  const even = 'crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0';
  const prepare = `fps=30,${even},format=yuv420p,settb=AVTB`;
  const mp4 = output(light ? 'light' : 'dark', 'mp4');
  run('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-i',
    files[0]!,
    '-vf',
    even,
    '-c:v',
    'libwebp',
    '-lossless',
    '1',
    mp4.replace(/\.mp4$/, '-poster.webp'),
  ]);
  run('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-loop',
    '1',
    '-framerate',
    '30',
    '-t',
    String(fade),
    '-i',
    files[0]!,
    '-filter_complex',
    `[0:v]${prepare}[a];[1:v]${prepare}[b];[a][b]xfade=transition=fade:duration=${fade}:offset=${(total - fade).toFixed(3)}[v]`,
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '18',
    '-movflags',
    '+faststart',
    mp4,
  ]);
  return total;
}

/** Draws the window capture onto the transparent canvas with border and shadow. */
async function compose(capture: Buffer, borderColor: string): Promise<Buffer> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const png = await page.evaluate(
      async ({ src, frame, borderColor, shadow }) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        const b = frame.border;
        const w = image.width + 2 * b;
        const h = image.height + 2 * b;
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
            if (Math.hypot(qx, qy) <= r) continue;
            // The table counts whole pixels from the edge, starting at 1.
            const d = (Math.hypot(qx, qy) - r) / frame.shadowScale + 0.5;
            const i = Math.floor(d);
            const near = shadow[Math.max(i - 1, 0)] ?? 0;
            const far = shadow[i] ?? 0;
            pixels.data[(y * width + x) * 4 + 3] = Math.round(near + (far - near) * (d - i));
          }
        }
        ctx.putImageData(pixels, 0, 0);
        ctx.fillStyle = borderColor;
        ctx.beginPath();
        ctx.roundRect(frame.left, frame.top, w, h, r);
        ctx.fill();
        ctx.beginPath();
        ctx.roundRect(frame.left + b, frame.top + b, w - 2 * b, h - 2 * b, r - b);
        ctx.clip();
        ctx.drawImage(image, frame.left + b, frame.top + b);
        return canvas.toDataURL('image/png');
      },
      { src: `data:image/png;base64,${capture.toString('base64')}`, frame, borderColor, shadow },
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
if (video) trustSftpServer();
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
  if (video) {
    if (moveToDoubleScaleMonitor(ftpeach.pid!)) {
      await waitFor(
        'the window to take the monitor scale',
        async () => (await page.evaluate(() => window.devicePixelRatio)) === 2 || undefined,
        10,
      );
    }
    const ratio = await page.evaluate(() => window.devicePixelRatio);
    if (ratio !== 2) console.warn(`No monitor at 200%; recording at ${ratio * 100}%.`);
    await stageVideo(page);
    const frames = path.join(profile, 'frames');
    const { files, durations } = await record(page, frames, () => playVideo(page));
    const seconds = encode(files, durations, frames);
    console.log(
      `Saved ${path.relative(root, output(light ? 'light' : 'dark', 'mp4'))}: ${files.length} frames, ${seconds.toFixed(1)} s. Watch it before committing.`,
    );
    await browser.close();
  } else {
    await stage(page);
    await screenshot(page);
    await browser.close();
  }
} finally {
  stop(ftpeach);
  stop(vite);
  cleanServer();
  rmSync(profile, { recursive: true, force: true });
}

async function screenshot(page: Page) {
  // WebView2 applies monitor DPI through page zoom. Playwright's explicit
  // screenshot clip mixes CSS and device pixels there, cropping the window.
  // Let Chromium capture the complete native viewport without a clip. The
  // zoom stays on top of an emulated scale factor, so the override divides it
  // out to keep the layout at the window's CSS size.
  const cdp = await page.context().newCDPSession(page);
  const [cssWidth, cssHeight, zoom] = await page.evaluate(() => [
    window.innerWidth,
    window.innerHeight,
    window.devicePixelRatio,
  ]);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: Math.round(cssWidth * zoom),
    height: Math.round(cssHeight * zoom),
    deviceScaleFactor: pixelRatio / zoom,
    mobile: false,
  });
  // A paused page runs no transitions, so a colour that eases to the other
  // theme would be captured at its start.
  await page.addStyleTag({ content: '*, ::before, ::after { transition: none !important; }' });
  await page.waitForTimeout(500);
  // Pausing takes effect when the page next runs JavaScript, which the
  // running upload's progress makes it do several times a second. The theme
  // is the root's data-theme and CSS alone, so DOM.setAttributeValue switches
  // it while nothing else can change.
  await cdp.send('Debugger.enable');
  const paused = new Promise((resolve) => cdp.once('Debugger.paused', resolve));
  await cdp.send('Debugger.pause');
  await paused;
  const { root: doc } = await cdp.send('DOM.getDocument', { depth: 1 });
  const html = doc.children!.find((node) => node.nodeName === 'HTML')!.nodeId;
  const captures: Partial<Record<'dark' | 'light', Buffer>> = {};
  for (const theme of ['dark', 'light'] as const) {
    await cdp.send('DOM.setAttributeValue', { nodeId: html, name: 'data-theme', value: theme });
    const capture = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    captures[theme] = Buffer.from(capture.data, 'base64');
  }
  await cdp.send('DOM.setAttributeValue', { nodeId: html, name: 'data-theme', value: 'dark' });
  await cdp.send('Debugger.resume');
  await cdp.send('Debugger.disable');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.detach();
  for (const theme of ['dark', 'light'] as const) {
    const png = await compose(captures[theme]!, frame.borderColor[theme]);
    writeFileSync(output(theme, 'png'), png);
    console.log(`Saved ${path.relative(root, output(theme, 'png'))}.`);
  }
  // The landing page crops the pictures to the window with these (.crop in site/index.html).
  const [w, h] = [cssWidth, cssHeight].map((side) => side! * pixelRatio + 2 * frame.border);
  console.log(
    `--iw: ${w! + frame.left + frame.right}; --ih: ${h! + frame.top + frame.bottom}; --x: ${frame.left}; --y: ${frame.top}; --w: ${w}; --h: ${h};`,
  );
  console.log('Look at both before committing.');
  await page.getByRole('button', { name: 'Stop active transfers' }).click();
}
