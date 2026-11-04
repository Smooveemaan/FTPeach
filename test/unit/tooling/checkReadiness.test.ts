import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../../scripts/release/check-readiness.ts', import.meta.url),
);
test('readiness is emitted only after both mandatory check stages succeed', () => {
  for (const failed of [undefined, 'mode', 'checks', 'private-check']) {
    for (const result of failed ? ['failure', 'cancelled', 'skipped', undefined] : ['success']) {
      const directory = mkdtempSync(path.join(tmpdir(), 'readiness-test-'));
      const results = Object.fromEntries(
        ['mode', 'checks', 'private-check'].map((name) => [
          name,
          { result: name === failed ? result : 'success' },
        ]),
      );
      writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '0.6.1' }));
      writeFileSync(
        path.join(directory, 'private-check.json'),
        JSON.stringify({ runId: 456, testSha: 'b'.repeat(40) }),
      );
      const child = spawnSync(process.execPath, ['--experimental-strip-types', script], {
        cwd: directory,
        env: {
          ...process.env,
          RESULTS: JSON.stringify(results),
          GITHUB_SHA: 'a'.repeat(40),
          GITHUB_REPOSITORY: 'owner/app',
          GITHUB_RUN_ID: '123',
          GITHUB_RUN_ATTEMPT: '2',
          GITHUB_STEP_SUMMARY: path.join(directory, 'summary.md'),
        },
        encoding: 'utf8',
      });
      const evidence = path.join(directory, 'release-readiness.json');
      assert.equal(child.status, failed ? 1 : 0, child.stderr);
      assert.equal(existsSync(evidence), !failed);
      if (!failed) {
        const ready = JSON.parse(readFileSync(evidence, 'utf8'));
        assert.equal(ready.sha, 'a'.repeat(40));
        assert.equal(ready.attempt, '2');
        assert.equal(ready.privateCheck.runId, 456);
      }
    }
  }
});
