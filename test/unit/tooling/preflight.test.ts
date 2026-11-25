import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPreflightPlan } from '../../../scripts/checks/preflight.ts';

const allExist = () => true;

test('preflight targets Prettier to existing changed files and falls back on config edits', () => {
  const targeted = buildPreflightPlan(['src/shared/contentZoom.ts', 'src/deleted.ts'], {
    fileExists: (file) => file !== 'src/deleted.ts',
  });
  const fmt = targeted.parallelSteps.find((step) => step.name.startsWith('format:check'));
  assert.ok(fmt, 'targeted format:check step should be scheduled');
  assert.equal(fmt.command, process.execPath);
  assert.ok(fmt.args.includes('--check'));
  assert.ok(fmt.args.includes('src/shared/contentZoom.ts'));
  assert.ok(!fmt.args.includes('src/deleted.ts'));

  const onConfig = buildPreflightPlan(['.prettierrc', 'src/shared/contentZoom.ts'], {
    fileExists: allExist,
  });
  const fullFmt = onConfig.parallelSteps.find((step) => step.name === 'format:check');
  assert.ok(fullFmt);
  assert.equal(fullFmt.command, 'npm');
  assert.deepEqual(fullFmt.args, ['run', 'format:check']);
});

test('preflight schedules vitest related for frontend changes and full components on config/forceAll', () => {
  const frontend = buildPreflightPlan(['src/features/settings/useSettings.ts'], {
    fileExists: allExist,
  });
  const related = frontend.parallelSteps.find((step) => step.name === 'test:components (related)');
  assert.ok(related, 'vitest related should run for src/ edits');
  assert.equal(related.command, process.execPath);
  assert.ok(related.args.includes('related'));
  assert.ok(related.args.includes('--passWithNoTests'));
  assert.ok(related.args.includes('src/features/settings/useSettings.ts'));

  const onVitestConfig = buildPreflightPlan(['vitest.config.ts'], { fileExists: allExist });
  assert.ok(onVitestConfig.parallelSteps.some((step) => step.name === 'test:components'));

  const toolingOnly = buildPreflightPlan(['scripts/checks/preflight.ts'], {
    fileExists: allExist,
  });
  assert.ok(!toolingOnly.parallelSteps.some((step) => step.name.startsWith('test:components')));
  assert.ok(!toolingOnly.parallelSteps.some((step) => step.name === 'test:unit'));
});

test('preflight isolates Rust checks into the serial rustSteps lane', () => {
  const plan = buildPreflightPlan(['src-tauri/src/protocol/ftp.rs', 'src/platform/tauriApi.ts'], {
    fileExists: allExist,
  });
  assert.deepEqual(
    plan.rustSteps.map((step) => step.name),
    ['cargo fmt check', 'rust:check', 'test:parser-regressions'],
  );
  assert.ok(plan.parallelSteps.some((step) => step.name === 'lint'));
  assert.ok(plan.parallelSteps.some((step) => step.name === 'check:command-acl'));
});
