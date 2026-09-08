// Local stand-in for a real update feed (GitHub Releases or otherwise) —
// see docs/updater-signing.md. Serves exactly two files from this
// directory: latest.json (the manifest) and dummy-update.bin (the signed
// "artifact"). Whether the real feed ends up being GitHub Releases, a
// separate public releases-only repo, or something self-hosted is a
// production-distribution decision this spike deliberately doesn't need to
// make — tauri-plugin-updater only cares that *some* HTTP(S) endpoint
// serves this shape.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 17890;
const ROOT = __dirname;

const CONTENT_TYPES = { '.json': 'application/json', '.bin': 'application/octet-stream' };

http
  .createServer((req, res) => {
    const file = path.join(ROOT, path.basename(req.url.split('?')[0]));
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      const type = CONTENT_TYPES[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type }).end(data);
    });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`updater spike feed on http://127.0.0.1:${PORT}/latest.json`);
  });
