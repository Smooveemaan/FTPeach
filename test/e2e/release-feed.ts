// A loopback-only substitute for the production HTTPS feed on disposable Windows runners.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyCandidate } from '../../scripts/release/candidate.ts';

export const PRODUCTION_FEED = '/Smooveemaan/ftpeach/releases/latest/download/latest.json';

export function productionFeed(
  version: string,
  installerSignature: string,
  portableSignature: string,
) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.ok(installerSignature.trim() && portableSignature.trim(), 'Both signatures are required');
  return {
    version,
    notes: 'Final package acceptance',
    pub_date: '2026-01-01T00:00:00Z',
    platforms: {
      'windows-x86_64': {
        url: `https://github.com/FTPeach_${version}_x64-setup.exe`,
        signature: installerSignature.trim(),
      },
      'windows-x86_64-portable': {
        url: `https://github.com/FTPeach_${version}_x64-portable.zip`,
        signature: portableSignature.trim(),
      },
    },
  };
}

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

function tracked(server: Server) {
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  };
}

export async function productionProxy(targetPort: number) {
  const server = createHttpServer((_request, response) => response.writeHead(403).end());
  const close = tracked(server);
  server.on('connect', (request, client, head) => {
    if (request.url !== 'github.com:443') {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = connect(targetPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}`;
  return {
    env: {
      HTTP_PROXY: url,
      http_proxy: url,
      HTTPS_PROXY: url,
      https_proxy: url,
      ALL_PROXY: url,
      all_proxy: url,
      NO_PROXY: '',
      no_proxy: '',
    },
    close,
  };
}

/** Installs a temporary CA only in the disposable account; no app config or signing key changes. */
export async function serveProductionFeed(directory: string) {
  const { requireThrowawayMachine } = await import('./install.ts');
  requireThrowawayMachine();
  assert.equal(process.platform, 'win32');
  const candidate = await verifyCandidate(directory);
  const version = candidate.readiness.version;
  const names = [`FTPeach_${version}_x64-setup.exe`, `FTPeach_${version}_x64-portable.zip`];
  const feed = productionFeed(
    version,
    readFileSync(path.join(directory, `${names[0]}.sig`), 'utf8'),
    readFileSync(path.join(directory, `${names[1]}.sig`), 'utf8'),
  );
  const temporary = await mkdtemp(path.join(tmpdir(), 'ftpeach-release-feed-'));
  const password = randomBytes(32).toString('hex');
  const powershell = (script: string) =>
    execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      env: { ...process.env, RELEASE_FEED_DIR: temporary, RELEASE_FEED_PASSWORD: password },
    }).trim();
  let certificates: { root: string; leaf: string } | undefined;
  let closeHttps: (() => Promise<void>) | undefined;
  let proxy: Awaited<ReturnType<typeof productionProxy>> | undefined;
  async function close() {
    try {
      await proxy?.close();
    } finally {
      try {
        await closeHttps?.();
      } finally {
        try {
          if (certificates) {
            assert.match(certificates.root, /^[0-9A-F]{40}$/);
            assert.match(certificates.leaf, /^[0-9A-F]{40}$/);
            powershell(`$ErrorActionPreference = 'Stop'
              $rootPath = 'Cert:\\CurrentUser\\Root\\${certificates.root}'
              if (Test-Path -LiteralPath $rootPath) { Remove-Item -LiteralPath $rootPath }
              foreach ($certPath in @('Cert:\\CurrentUser\\My\\${certificates.leaf}', 'Cert:\\CurrentUser\\My\\${certificates.root}')) {
                if (Test-Path -LiteralPath $certPath) { Remove-Item -LiteralPath $certPath -DeleteKey }
              }`);
          }
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      }
    }
  }
  try {
    powershell(`$ErrorActionPreference = 'Stop'
      $root = $null; $leaf = $null
      try {
        $root = New-SelfSignedCertificate -Type Custom -Subject ('CN=FTPeach disposable feed ' + [guid]::NewGuid()) -KeyUsage CertSign,CRLSign,DigitalSignature -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=0') -CertStoreLocation Cert:\\CurrentUser\\My -KeyExportPolicy Exportable -NotAfter (Get-Date).AddDays(1)
        $leaf = New-SelfSignedCertificate -Type SSLServerAuthentication -DnsName github.com -Signer $root -CertStoreLocation Cert:\\CurrentUser\\My -KeyExportPolicy Exportable -NotAfter (Get-Date).AddDays(1)
        Export-Certificate -Cert $root -FilePath (Join-Path $env:RELEASE_FEED_DIR 'root.cer') | Out-Null
        Export-PfxCertificate -Cert $leaf -FilePath (Join-Path $env:RELEASE_FEED_DIR 'server.pfx') -Password (ConvertTo-SecureString $env:RELEASE_FEED_PASSWORD -AsPlainText -Force) | Out-Null
        @{ root = $root.Thumbprint; leaf = $leaf.Thumbprint } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $env:RELEASE_FEED_DIR 'certificates.json') -Encoding ascii
        Import-Certificate -FilePath (Join-Path $env:RELEASE_FEED_DIR 'root.cer') -CertStoreLocation Cert:\\CurrentUser\\Root | Out-Null
      } catch {
        if ($root) { Remove-Item -LiteralPath ('Cert:\\CurrentUser\\Root\\' + $root.Thumbprint) -ErrorAction SilentlyContinue }
        foreach ($cert in @($leaf, $root)) { if ($cert) { Remove-Item -LiteralPath ('Cert:\\CurrentUser\\My\\' + $cert.Thumbprint) -DeleteKey -ErrorAction SilentlyContinue } }
        throw
      }`);
    certificates = JSON.parse(readFileSync(path.join(temporary, 'certificates.json'), 'utf8'));
    const requests: string[] = [];
    const server = createHttpsServer(
      { pfx: readFileSync(path.join(temporary, 'server.pfx')), passphrase: password },
      (request, response) => {
        const url = request.url ?? '';
        requests.push(url);
        if (request.method !== 'GET' || request.headers.host !== 'github.com') {
          response.writeHead(403).end();
        } else if (url === PRODUCTION_FEED) {
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(feed));
        } else {
          const name = names.find((name) => url === `/${name}`);
          if (!name) response.writeHead(404).end();
          else
            response
              .writeHead(200, { 'Content-Type': 'application/octet-stream' })
              .end(readFileSync(path.join(directory, name)));
        }
      },
    );
    closeHttps = tracked(server);
    proxy = await productionProxy(await listen(server));
    return { env: proxy.env, requests, close };
  } catch (error) {
    await close();
    throw error;
  }
}
