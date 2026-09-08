// `npm run check` is the local stand-in for CI. That only holds while it still
// runs what CI runs, and nothing enforced that: the script had already drifted
// behind checks.yml by two steps, so a push could pass locally and fail on the
// runner over work the developer never had a chance to see.
//
// This asserts the workflow's npm steps are reachable from `check`, with a
// short list of deliberate exclusions that must each stay justified.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const packagePath = new URL('../../package.json', import.meta.url);
const workflowPath = new URL('../../.github/workflows/checks.yml', import.meta.url);

const scripts: Record<string, string> = JSON.parse(await readFile(packagePath, 'utf8')).scripts;
const workflow = await readFile(workflowPath, 'utf8');

const entryPoint = 'check';

// Steps CI runs that `check` deliberately leaves out. Each needs a reason, and
// each has to still appear in the workflow, so a step that disappears upstream
// cannot leave a stale exemption quietly standing.
const excluded = new Map([
  [
    'test:packaged-smoke',
    'builds and drives a packaged Tauri binary; minutes per run, so CI owns it',
  ],
]);

/** Every script an `npm run` / `npm test` command in `source` invokes. */
function invoked(source: string): string[] {
  const names = [...source.matchAll(/npm run ([\w:-]+)/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
  // `npm test` is the one script with a bare alias, and both spellings appear.
  if (/npm test\b/.test(source)) names.push('test');
  return names;
}

const reachable = new Set<string>();
const pending = [entryPoint];
while (pending.length > 0) {
  const name = pending.pop()!;
  if (reachable.has(name)) continue;
  reachable.add(name);
  const body = scripts[name];
  if (body) pending.push(...invoked(body));
}

const problems: string[] = [];
const workflowScripts = new Set(invoked(workflow));

for (const name of [...workflowScripts].sort()) {
  if (reachable.has(name) || excluded.has(name)) continue;
  problems.push(`${name}: run by checks.yml but not reachable from \`npm run ${entryPoint}\``);
}

for (const [name, reason] of excluded) {
  if (workflowScripts.has(name)) continue;
  problems.push(`${name}: excluded as "${reason}", but checks.yml no longer runs it`);
}

assert.equal(
  problems.length,
  0,
  `Local check suite is out of step with checks.yml:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
);

const covered = [...workflowScripts].filter((name) => reachable.has(name)).length;
console.log(
  `Local suite covers ${covered} of checks.yml's ${workflowScripts.size} npm steps (${excluded.size} excluded by design)`,
);
