/* global document */
// Draws the link previews: assets/images/og.jpg (1200x630), which the website
// names as its Open Graph image, and github-social.jpg (1280x640), uploaded by
// hand in the repository's Settings > Social preview. Both use the website's own
// fonts and dark colours, read from site/index.html, so they follow the page.
// `npm run site:social` redraws them after the headline, fonts or icon change.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '../..');
const site = await readFile(path.join(root, 'site/index.html'), 'utf8');
const fonts = site.match(/@font-face \{[\s\S]*?\n\}/g)?.join('\n');
if (!fonts) throw new Error('No @font-face rules found in site/index.html');
const icon = (await readFile(path.join(root, 'src-tauri/icons/128x128@2x.png'))).toString('base64');
const grain =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E";

// The page's dark theme: --paper, --card, --line, --ink, --muted, --peach and --peach-ink.
const page = `<!doctype html><html><head><meta charset="utf-8"><style>
${fonts}
* { margin: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; }
body {
  background: #131211; color: #f2f0ed; font-family: 'Figtree', sans-serif;
  display: grid; place-content: center; justify-items: center; gap: 30px; text-align: center;
  position: relative; overflow: hidden; -webkit-font-smoothing: antialiased;
}
body::before {
  content: ''; position: absolute; inset: 0; z-index: -1;
  background: radial-gradient(46% 62% at 50% 38%, color-mix(in oklab, #f0915f 18%, transparent), transparent 74%);
}
body::after {
  content: ''; position: absolute; inset: 0; opacity: 0.06; mix-blend-mode: screen;
  background-image: url("${grain}");
}
.brand { display: flex; align-items: center; gap: 18px; font: 600 50px/1 'Fraunces', serif; letter-spacing: -0.02em; }
.brand img { width: 76px; height: 76px; }
h1 { font: 600 82px/1 'Fraunces', serif; letter-spacing: -0.035em; max-width: 15ch; }
h1 em { color: #f6a77d; font-weight: 500; }
ul { display: flex; gap: 12px; padding: 0; list-style: none; margin-top: 6px; }
li { padding: 7px 16px; border-radius: 11px; border: 1.5px solid #33312e; background: #1c1b19; font: 500 22px/1.4 'IBM Plex Mono', monospace; }
p { font-size: 24px; color: #aba6a0; margin-top: -8px; }
</style></head><body>
<div class="brand"><img src="data:image/png;base64,${icon}" alt="">FTPeach</div>
<h1>Drag files to your server <em>and back.</em></h1>
<ul><li>FTP</li><li>FTPS</li><li>SFTP</li><li>WebDAV</li></ul>
<p>Free and open source · Windows 10 and 11</p>
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
