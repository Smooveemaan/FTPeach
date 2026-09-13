/* global document, requestAnimationFrame, MutationObserver, HTMLElement */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const server = await createServer({
  server: { host: '127.0.0.1', port: 4187, strictPort: true, watch: null },
});
await server.listen();
const browser = await chromium.launch();
const results = [];
try {
  for (const count of [1000, 10_000, 100_000]) {
    for (const active of [1, 8, 32]) {
      console.log(`Starting current: ${count} rows, ${active} running`);
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.setDefaultTimeout(30_000);
      const errors: string[] = [];
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Performance.enable');
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.goto('http://127.0.0.1:4187/visual.html');
      await page.locator('.pane-list').first().waitFor();
      let scenarioTimer: ReturnType<typeof setTimeout> | undefined;
      const scenario = page.evaluate(
        async ({ count, active }) => {
          const path = '/src/features/transfers/transferStore.ts';
          const store = await import(/* @vite-ignore */ path);
          const rows = Object.fromEntries(
            Array.from({ length: count }, (_, i) => {
              const id = `row-${i}`;
              return [
                id,
                {
                  id,
                  attemptId: id,
                  direction: 'down',
                  protocol: 'sftp',
                  connectionId: 'visual-remote',
                  remoteFile: `/file-${i}`,
                  localTarget: `C:/target/${i}`,
                  name: `file-${i}`,
                  bytes: 0,
                  total: 100_000,
                  status: i < active ? 'progress' : ['error', 'paused', 'stopped', 'queued'][i % 4],
                  startedAt: count - i,
                },
              ];
            }),
          );
          store.setTransfersStore(rows);
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          const samples = [];
          for (let sample = 0; sample < 25; sample++) {
            const bytes = sample + 1;
            const duration = await new Promise<number>((resolve, reject) => {
              const start = performance.now();
              const timeout = setTimeout(() => {
                observer.disconnect();
                reject(new Error('No progress commit'));
              }, 15_000);
              const observer = new MutationObserver(() => {
                const text = document.querySelector(
                  '.transfer-item [data-column-cell="transferred"]',
                )?.textContent;
                if (!text?.startsWith(`${bytes} `)) return;
                observer.disconnect();
                clearTimeout(timeout);
                resolve(performance.now() - start);
              });
              observer.observe(document.querySelector('.transfer-list')!, {
                subtree: true,
                childList: true,
                characterData: true,
              });
              for (let i = 0; i < active; i++) {
                const id = `row-${i}`;
                store.updateTransferRow(id, (row: object) => ({ ...row, bytes }), true);
              }
            });
            if (sample >= 5) samples.push(duration);
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          }
          const list = document.querySelector<HTMLElement>('.transfer-list')!;
          const scrollSamples = [];
          for (let i = 0; i < 25; i++) {
            const start = performance.now();
            list.scrollTop = i % 2 ? 0 : list.scrollHeight * 0.7;
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            );
            if (i >= 5) scrollSamples.push(performance.now() - start);
          }
          const sorted = [...samples].sort((a, b) => a - b);
          const scrollSorted = [...scrollSamples].sort((a, b) => a - b);
          return {
            count,
            active,
            medianMs: sorted[9],
            p95Ms: sorted[18],
            scrollP95Ms: scrollSorted[18],
            samples,
            scrollSamples,
            domRows: document.querySelectorAll('.transfer-item').length,
            heap: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
              ?.usedJSHeapSize,
          };
        },
        { count, active },
      );
      const result = await Promise.race([
        scenario,
        new Promise<never>((_, reject) => {
          scenarioTimer = setTimeout(
            () => reject(new Error('Scenario exceeded 60 seconds')),
            60_000,
          );
        }),
      ]).finally(() => clearTimeout(scenarioTimer));
      if (errors.length) throw new Error(errors.join('\n'));
      if (result.domRows > 100) throw new Error(`Unbounded DOM: ${result.domRows}`);
      console.log(JSON.stringify(result));
      const metrics = await cdp.send('Performance.getMetrics');
      const dom = await cdp.send('Memory.getDOMCounters');
      results.push({ ...result, metrics, dom });
      if (count === 10_000 && active === 32) {
        await page.setViewportSize({ width: 850, height: 700 });
        await page.evaluate(() => {
          document.documentElement.dir = 'rtl';
          document.documentElement.style.zoom = '1.25';
        });
        await page.screenshot({ path: '.local/stage3-queue-rtl.png' });
        if ((await page.locator('.transfer-item').count()) > 100)
          throw new Error('Narrow RTL virtualization failed');
      }
      await page.close();
    }
  }
} finally {
  mkdirSync('.local', { recursive: true });
  writeFileSync(
    `.local/stage3-ui-after.json`,
    JSON.stringify(
      {
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),

        browser: browser.version(),
        measuredAt: new Date().toISOString(),
        note: 'Vite Chromium; mutation-to-DOM-commit including 16ms coalescing; scroll measures two animation frames, not compositor presentation. Not packaged WebView2.',
        results,
      },
      null,
      2,
    ),
  );
  await browser.close();
  await server.close();
}
