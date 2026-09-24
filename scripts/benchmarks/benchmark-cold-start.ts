// Launches a built FTPeach several times and reads, over WebView2's DevTools
// port, when the main window painted. `#root` starts empty, so
// first-contentful-paint is React's first frame. Times are from spawn.
//
//   npm run build:tauri
//   npm run benchmark:cold-start -- [path\to\app.exe] [runs]
//
// Close every running FTPeach first: the single-instance plugin hands a second
// launch to the running one, and no window of ours ever appears.
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';

const [
  exe = path.join(process.env.LOCALAPPDATA ?? '', 'FTPeachBuild', 'target', 'release', 'app.exe'),
  runs = '6',
] = process.argv.slice(2);
const port = 9333;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Target = { type: string; url: string; webSocketDebuggerUrl: string };
type Probe = { origin: number; fcp: number; buttons: number };

async function mainWindowTarget(deadline: number): Promise<Target> {
  while (Date.now() < deadline) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Target[];
      const page = targets.find(
        (target) => target.type === 'page' && !target.url.includes('security-confirmation'),
      );
      if (page) return page;
    } catch {
      // The DevTools port is not listening yet.
    }
    await sleep(20);
  }
  throw new Error('No main window appeared. Is FTPeach already running?');
}

function evaluate(url: string, expression: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      socket.close();
      if (message.error || message.result?.exceptionDetails) {
        reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
      } else resolve(message.result.result.value);
    };
    socket.onerror = () => reject(new Error('DevTools connection failed'));
  });
}

const probe = `new Promise((resolve) => {
  const read = () => {
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    if (!fcp) return setTimeout(read, 50);
    resolve({
      origin: performance.timeOrigin,
      fcp: fcp.startTime,
      buttons: document.querySelectorAll('button').length,
    });
  };
  read();
})`;

async function measure(url: string): Promise<Probe> {
  // The target is listed before its document exists, and the first document
  // is replaced by the app's; retry until a context answers.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await evaluate(url, probe)) as Probe;
    } catch (error) {
      if (attempt > 100) throw error;
      await sleep(50);
    }
  }
}

const samples: Array<{ navigation: number; paint: number }> = [];
for (let run = 1; run <= Number(runs); run += 1) {
  const spawned = Date.now();
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: 'ignore',
  });
  try {
    const result = await measure(
      (await mainWindowTarget(Date.now() + 30_000)).webSocketDebuggerUrl,
    );
    const sample = {
      navigation: Math.round(result.origin - spawned),
      paint: Math.round(result.origin + result.fcp - spawned),
    };
    samples.push(sample);
    console.log(
      `run ${run}: navigation ${sample.navigation} ms, first paint ${sample.paint} ms (${result.buttons} buttons)`,
    );
  } finally {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await sleep(2000);
  }
}

const paints = samples.map((sample) => sample.paint).sort((a, b) => a - b);
console.log(
  `first paint: ${paints[0]}-${paints.at(-1)} ms, median ${paints[Math.floor(paints.length / 2)]} ms`,
);
