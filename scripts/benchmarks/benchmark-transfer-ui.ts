/* global requestAnimationFrame, MutationObserver, document */
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

// Paired browser benchmark: identical application and dataset, with the previous
// unbounded store algorithm or the current retained/indexed implementation.
// Measures mutation-to-DOM-commit, not compositor presentation or native WebView.
const port = 4187;
const origin = `http://127.0.0.1:${port}`;
const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort'],
  {
    windowsHide: true,
    stdio: 'ignore',
  },
);
const previousStore = `
let state = {};
const listeners = new Set();
export const COMPLETED_RETENTION = Infinity;
export const getTransfersSnapshot = () => state;
export const subscribeTransfers = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
export const resetTransfersStoreForTests = () => { state = {}; };
export const transferTargetKey = (row) => row.dragOut ? undefined : row.direction === 'down' ? 'local:' + row.localTarget.replaceAll('/', '\\\\').toLowerCase() : 'remote:' + (row.connectionId || row.targetConnectionId) + ':' + row.remoteTarget;
export const transferForAttempt = (id) => Object.values(state).find(row => (row.attemptId || row.id) === id);
export const activeTransferForTarget = (key) => Object.values(state).find(row => ['queued', 'progress', 'cancelling'].includes(row.status) && transferTargetKey(row) === key);
export const setTransfersStore = (updater) => { const next = typeof updater === 'function' ? updater(state) : updater; if (Object.is(next, state)) return; state = next; listeners.forEach(listener => listener()); };
`;

try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    ready = await fetch(`${origin}/visual.html`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('Benchmark server did not start');
  const browser = await chromium.launch();
  try {
    console.log('Completed rows | Store | DOM commit median ms | p95 ms | Retained rows');
    for (const count of [10_000, 100_000]) {
      for (const mode of ['current', 'previous']) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        page.setDefaultTimeout(30_000);
        if (mode === 'previous') {
          await page.route('**/src/features/transfers/transferStore.ts*', (route) =>
            route.fulfill({
              contentType: 'application/javascript',
              body: previousStore,
            }),
          );
        }
        await page.goto(`${origin}/visual.html`);
        await page.locator('.pane-list').first().waitFor();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            page.evaluate(async (completed) => {
              const modulePath = '/src/features/transfers/transferStore.ts';
              const store = await import(/* @vite-ignore */ modulePath);
              const rows = Object.fromEntries(
                Array.from({ length: completed }, (_, index) => [
                  String(index),
                  {
                    id: String(index),
                    attemptId: String(index),
                    direction: 'down',
                    protocol: 'sftp',
                    connectionId: 'visual-remote',
                    remoteFile: `/file-${index}`,
                    localTarget: `C:\\target\\${index}`,
                    name: `file-${index}`,
                    bytes: 1024,
                    total: 1024,
                    status: 'done',
                    startedAt: index,
                  },
                ]),
              );
              rows.active = {
                ...rows['0']!,
                id: 'active',
                attemptId: 'active',
                name: 'benchmark-ready',
                status: 'progress',
                startedAt: Date.now(),
              };
              store.setTransfersStore(rows);
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              );
              const samples: number[] = [];
              for (let index = 0; index < 7; index++) {
                const name = `benchmark-update-${index}`;
                const elapsed = await new Promise<number>((resolve, reject) => {
                  const timeout = setTimeout(() => {
                    observer.disconnect();
                    reject(new Error('Transfer row did not render'));
                  }, 5000);
                  const observer = new MutationObserver(() => {
                    if (!document.body.textContent?.includes(name)) return;
                    clearTimeout(timeout);
                    observer.disconnect();
                    resolve(performance.now() - start);
                  });
                  observer.observe(document.body, {
                    subtree: true,
                    childList: true,
                    characterData: true,
                  });
                  const start = performance.now();
                  const active = store.transferForAttempt('active');
                  store.setTransfersStore((current: Record<string, unknown>) => ({
                    ...current,
                    active: { ...active, name },
                  }));
                });
                if (index >= 2) samples.push(elapsed);
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              }
              samples.sort((a, b) => a - b);
              return {
                median: samples[2]!,
                p95: samples[4]!,
                retained: Object.keys(store.getTransfersSnapshot()).length,
              };
            }, count),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error('Scenario exceeded its time budget including initial rendering'),
                  ),
                count === 10_000 ? 60_000 : 30_000,
              );
            }),
          ]);
          console.log(
            `${count} | ${mode} | ${result.median.toFixed(2)} | ${result.p95.toFixed(2)} | ${result.retained}`,
          );
        } catch (error) {
          if (mode !== 'previous' || !String(error).includes('exceeded its time budget'))
            throw error;
          console.log(
            `${count} | ${mode} | scenario exceeded ${count === 10_000 ? 60 : 30} s including initial rendering`,
          );
        } finally {
          clearTimeout(timer);
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
}
