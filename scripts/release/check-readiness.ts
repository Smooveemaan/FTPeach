import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';

const results = JSON.parse(process.env.RESULTS!) as Record<string, { result: string }>;
for (const name of ['mode', 'checks', 'private-check'])
  assert.equal(results[name]?.result, 'success', `${name} is not successful`);
const { version } = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
const privateCheck = JSON.parse(await readFile('private-check.json', 'utf8'));
await writeFile(
  'release-readiness.json',
  JSON.stringify(
    {
      schema: 1,
      repository: process.env.GITHUB_REPOSITORY,
      runId: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      sha: process.env.GITHUB_SHA,
      version,
      packages: ['windows-x86_64-nsis', 'windows-x86_64-portable'],
      privateCheck,
    },
    null,
    2,
  ),
);
await appendFile(
  process.env.GITHUB_STEP_SUMMARY!,
  `## Release check passed\n\nVersion ${version}, commit ${process.env.GITHUB_SHA}, attempt ${process.env.GITHUB_RUN_ATTEMPT}.\nPublic and closed checks passed; packaging may use run ID ${process.env.GITHUB_RUN_ID}.\n`,
);
