import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { test } from 'node:test';
import { productionFeed, productionProxy } from '../../e2e/release-feed.ts';

test('production acceptance preserves each package signature and keeps installed and portable targets separate', () => {
  const feed = productionFeed('0.6.1', ' installed-signature\n', ' portable-signature\n');
  assert.equal(feed.version, '0.6.1');
  assert.deepEqual(feed.platforms['windows-x86_64'], {
    url: 'https://github.com/FTPeach_0.6.1_x64-setup.exe',
    signature: 'installed-signature',
  });
  assert.deepEqual(feed.platforms['windows-x86_64-portable'], {
    url: 'https://github.com/FTPeach_0.6.1_x64-portable.zip',
    signature: 'portable-signature',
  });
  assert.throws(() => productionFeed('../0.6.1', 'installed', 'portable'));
  assert.throws(() => productionFeed('0.6.1', 'installed', ' '));
});

test('the acceptance proxy tunnels only github.com to loopback and refuses every other destination', async () => {
  const connections: string[] = [];
  const target = createServer((socket) => {
    socket.once('data', (data) => {
      connections.push(data.toString());
      socket.end('ack:ping');
    });
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const address = target.address();
  assert.ok(address && typeof address !== 'string');
  const proxy = await productionProxy(address.port);
  const url = new URL(proxy.env.HTTPS_PROXY);
  async function tunnel(destination: string) {
    return new Promise<string>((resolve, reject) => {
      const socket = connect(Number(url.port), url.hostname);
      const buffers: string[] = [];
      socket.setTimeout(5_000, () => socket.destroy(new Error('Proxy test timed out')));
      socket.once('connect', () =>
        socket.write(`CONNECT ${destination} HTTP/1.1\r\nHost: ${destination}\r\n\r\nping`),
      );
      socket.on('data', (chunk) => buffers.push(chunk.toString()));
      socket.once('end', () => resolve(buffers.join('')));
      socket.once('error', reject);
    });
  }
  try {
    assert.match(await tunnel('github.com:443'), /200 Connection Established\r\n\r\nack:ping$/);
    for (const destination of ['example.com:443', 'github.com:80', 'github.com.evil:443'])
      assert.match(await tunnel(destination), /^HTTP\/1\.1 403 Forbidden/);
    assert.equal(connections.length, 1);
    assert.equal(connections.join(''), 'ping');
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});
