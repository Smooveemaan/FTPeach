// CI parity, not code coverage: `npm run check` is the local stand-in for CI. That only holds while it still
// runs what CI runs, and nothing enforced that: the script had already drifted
// behind checks.yml by two steps, so a push could pass locally and fail on the
// runner over work the developer never had a chance to see.
//
// This asserts every npm step of the workflow is reachable from `check`.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const packagePath = new URL('../../package.json', import.meta.url);
const workflowPath = new URL('../../.github/workflows/checks.yml', import.meta.url);

const scripts: Record<string, string> = JSON.parse(await readFile(packagePath, 'utf8')).scripts;
const workflow = await readFile(workflowPath, 'utf8');

const entryPoint = 'check';

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
  if (reachable.has(name)) continue;
  problems.push(`${name}: run by checks.yml but not reachable from \`npm run ${entryPoint}\``);
}

assert.equal(
  problems.length,
  0,
  `Local check suite is out of step with checks.yml:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
);

const covered = [...workflowScripts].filter((name) => reachable.has(name)).length;
console.log(`Local suite covers ${covered} of checks.yml's ${workflowScripts.size} npm steps`);
