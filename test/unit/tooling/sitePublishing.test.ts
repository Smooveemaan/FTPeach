import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Pages checks the website before building and uploading the deployment artifact', async () => {
  const workflow = await readFile(
    new URL('../../../.github/workflows/pages.yml', import.meta.url),
    'utf8',
  );
  const checks = workflow.indexOf('run: npm run site:test');
  const build = workflow.indexOf('run: node --experimental-strip-types scripts/site/build.ts');
  const upload = workflow.indexOf('uses: actions/upload-pages-artifact@');
  assert.ok(checks >= 0 && checks < build && build < upload);
  assert.match(workflow, /ref: master/);
  assert.match(workflow, /needs: build/);
  assert.doesNotMatch(workflow, /continue-on-error: true/);
});
