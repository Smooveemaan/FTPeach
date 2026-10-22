/* global document */
// Draws the link previews: assets/images/og.jpg (1200x630), which the website
// names as its Open Graph image, and github-social.jpg (1280x640), uploaded by
// hand in the repository's Settings > Social preview. Both use the website's own
// fonts and dark colours, using the site's shared stylesheet, and the app's own screenshot.
// `npm run site:social` redraws them after the headline, fonts or icon change.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '../..');
const site = await readFile(path.join(root, 'site/styles.css'), 'utf8');
let fonts = site.match(/@font-face \{[\s\S]*?\n\}/g)?.join('\n');
if (!fonts) throw new Error('No @font-face rules found in site/styles.css');
for (const match of fonts.matchAll(/url\('([^']+)'\)/g)) {
  const data = await readFile(path.join(root, 'site', match[1]!));
  fonts = fonts.replace(match[0], `url(data:font/woff2;base64,${data.toString('base64')})`);
}
const icon = (await readFile(path.join(root, 'src-tauri/icons/128x128@2x.png'))).toString('base64');
const grain =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E";

const shot = (await readFile(path.join(root, 'assets/images/ftpeach-dark.png'))).toString('base64');

// The home page's dark theme and first screen: the headline at the left, the app running off the right edge.
const page = `<!doctype html><html><head><meta charset="utf-8"><style>
${fonts}
* { margin: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; }
body {
  background: #12100e; color: #f2f0ed; font-family: 'Albert Sans', sans-serif;
  position: relative; overflow: hidden; -webkit-font-smoothing: antialiased;
}
body::after {
  content: ''; position: absolute; inset: 0; opacity: 0.06; mix-blend-mode: screen;
  background-image: url("${grain}");
}
.brand { position: absolute; top: 56px; left: 64px; display: flex; align-items: center; gap: 14px; font: 650 34px/1 'Albert Sans', sans-serif; letter-spacing: -0.01em; }
.brand img { width: 52px; height: 52px; }
h1 { position: absolute; left: 64px; top: 170px; width: 7.4em; font: 650 68px/0.98 'Albert Sans', sans-serif; letter-spacing: -0.05em; }
p { position: absolute; left: 64px; bottom: 60px; font-size: 26px; line-height: 1.4; color: #aba6a0; }
.app { position: absolute; left: 600px; top: 96px; width: 900px; }
</style></head><body>
<div class="brand"><img src="data:image/png;base64,${icon}" alt="">FTPeach</div>
<h1>Drag files to your server and back.</h1>
<p>Free FTP, FTPS, SFTP and WebDAV<br>client for Windows</p>
<img class="app" src="data:image/png;base64,${shot}" alt="">
</body></html>`;

const browser = await chromium.launch();
try {
  for (const [name, width, height] of [
    ['og.jpg', 1200, 630],
    ['github-social.jpg', 1280, 640],
  ] as const) {
    const tab = await browser.newPage({ viewport: { width, height } });
    await tab.setContent(page);
    await tab.evaluate(() => document.fonts.ready);
    await tab.screenshot({
      path: path.join(root, 'assets/images', name),
      type: 'jpeg',
      quality: 88,
    });
    console.log(`Wrote assets/images/${name}`);
  }
} finally {
  await browser.close();
}
