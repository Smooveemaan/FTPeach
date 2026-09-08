import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { runBoundaryCheck } from '../../../scripts/checks/check-feature-boundaries.ts';

let root: string;

test('shared hooks, shortcuts and localization cannot own feature dependencies', async () => {
  await writeSource('features/a/index.ts', 'export const a = 1;');
  for (const area of ['hooks', 'shortcuts', 'i18n'])
    await writeSource(`${area}/helper.ts`, "export { a } from '../features/a/index.ts';");
  const { errors } = runBoundaryCheck(root);
  assert.equal(errors.length, 3);
  assert.ok(errors.every((error) => error.includes('imports feature a')));
});

test('nested index files are not public feature entrypoints', async () => {
  await writeSource('features/a/private/index.ts', 'export const a = 1;');
  await writeSource('app/useA.ts', "export { a } from '../features/a/private/index.ts';");
  assert.ok(runBoundaryCheck(root).errors.some((error) => error.includes('imports a internals')));
});

test('side effect imports cannot bypass internal feature boundaries', async () => {
  await writeSource('features/a/private.ts', 'export const a = 1;');
  await writeSource('app/useA.ts', "import '../features/a/private.ts';");
  assert.ok(runBoundaryCheck(root).errors.some((error) => error.includes('imports a internals')));
});

test('extensionless and directory imports participate in cycle detection', async () => {
  await writeSource('features/a/index.ts', "import '../b';");
  await writeSource('features/b/index.ts', "import '../a/index';");
  const { errors } = runBoundaryCheck(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /feature dependency cycle/);
});

test('comments and string literals do not create import edges', async () => {
  await writeSource('features/a/index.ts', 'export const a = 1;');
  await writeSource(
    'hooks/helper.ts',
    `// import '../features/a/index.ts';\nconst example = "import('../features/a/index.ts')";`,
  );
  assert.deepEqual(runBoundaryCheck(root).errors, []);
});

test('dynamic template imports and inline type imports follow the same boundaries', async () => {
  await writeSource('features/a/private.ts', 'export type A = string;');
  await writeSource(
    'app/useA.ts',
    'const a = import(`../features/a/private.ts`); type A = import("../features/a/private.ts").A;',
  );
  assert.equal(runBoundaryCheck(root).errors.length, 2);
});

test('unclassified folders cannot silently bypass source area checks', async () => {
  await writeSource('misc/helper.ts', 'export const helper = 1;');
  assert.ok(
    runBoundaryCheck(root).errors.some((error) => error.includes('unrecognized source area')),
  );
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ftpeach-boundaries-'));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function writeSource(relativePath: string, contents: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
}

test('a feature importing its own internal file is allowed', async () => {
  await writeSource('features/sites/index.ts', `export { useSites } from './useSites.ts';\n`);
  await writeSource('features/sites/useSites.ts', `export function useSites() {}\n`);

  const { errors } = runBoundaryCheck(root);
  assert.deepEqual(errors, []);
});

test('one feature importing another feature through its index.ts is allowed', async () => {
  await writeSource('features/a/index.ts', `export const a = 1;\n`);
  await writeSource(
    'features/b/index.ts',
    `import { a } from '../a/index.ts';\nexport const b = a;\n`,
  );

  const { errors } = runBoundaryCheck(root);
  assert.deepEqual(errors, []);
});

test('one feature reaching into another feature internals is rejected', async () => {
  await writeSource('features/a/internal.ts', `export const a = 1;\n`);
  await writeSource('features/a/index.ts', `export { a } from './internal.ts';\n`);
  await writeSource(
    'features/b/index.ts',
    `import { a } from '../a/internal.ts';\nexport const b = a;\n`,
  );

  const { errors } = runBoundaryCheck(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /imports a internals via/);
});

test('app importing a feature through its index.ts is allowed', async () => {
  await writeSource('features/settings/index.ts', `export const Settings = 1;\n`);
  await writeSource('app/App.tsx', `import { Settings } from '../features/settings/index.ts';\n`);

  const { errors } = runBoundaryCheck(root);
  assert.deepEqual(errors, []);
});

test('app reaching into a feature internal file is rejected', async () => {
  await writeSource('features/settings/useSettingsDraft.ts', `export const draft = 1;\n`);
  await writeSource(
    'features/settings/index.ts',
    `export { draft } from './useSettingsDraft.ts';\n`,
  );
  await writeSource(
    'app/App.tsx',
    `import { draft } from '../features/settings/useSettingsDraft.ts';\n`,
  );

  const { errors } = runBoundaryCheck(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /imports settings internals via/);
});

test('shared depending on a feature is rejected even through the public index.ts', async () => {
  await writeSource('features/sites/index.ts', `export const Sites = 1;\n`);
  await writeSource('shared/types.ts', `import { Sites } from '../features/sites/index.ts';\n`);

  const { errors } = runBoundaryCheck(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /\(shared\) imports feature sites/);
});

test('platform depending on a feature is rejected even through the public index.ts', async () => {
  await writeSource('features/sites/index.ts', `export const Sites = 1;\n`);
  await writeSource(
    'platform/tauriApi.ts',
    `import { Sites } from '../features/sites/index.ts';\n`,
  );

  const { errors } = runBoundaryCheck(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /\(platform\) imports feature sites/);
});

test('a feature depending on shared, components, or platform is allowed', async () => {
  await writeSource('shared/types.ts', `export type Id = string;\n`);
  await writeSource('components/Icon.tsx', `export default function Icon() {}\n`);
  await writeSource('platform/tauriApi.ts', `export const api = {};\n`);
  await writeSource(
    'features/sites/useSites.ts',
    [
      `import type { Id } from '../../shared/types.ts';`,
      `import Icon from '../../components/Icon.tsx';`,
      `import { api } from '../../platform/tauriApi.ts';`,
      `export { Id, Icon, api };`,
      '',
    ].join('\n'),
  );

  const { errors } = runBoundaryCheck(root);
  assert.deepEqual(errors, []);
});

test('a direct @tauri-apps/api import inside src/platform is allowed', async () => {
  await writeSource(
    'platform/tauriApi.ts',
    `import { invoke } from '@tauri-apps/api/core';\nexport { invoke };\n`,
  );

  const { errors } = runBoundaryCheck(root);
  assert.deepEqual(errors, []);
});

test('a direct @tauri-apps/api import outside src/platform is rejected', async () => {
  await writeSource(
    'components/SomeDialog.tsx',
    `import { invoke } from '@tauri-apps/api/core';\n`,
  );

  const { errors } = runBoundaryCheck(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /imports @tauri-apps\/api\/core directly outside src\/platform/);
});

test('the title bar must access native window controls through platform', async () => {
  await writeSource(
    'components/TitleBar.tsx',
    `import type { Window } from '@tauri-apps/api/window';\nexport type { Window };\n`,
  );

  const { errors } = runBoundaryCheck(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /directly outside src\/platform/);
});

test('a feature importing the app layer is rejected', async () => {
  await writeSource('app/appState.ts', `export const appState = {};\n`);
  await writeSource(
    'features/settings/useSettings.ts',
    `import { appState } from '../../app/appState.ts';\nexport { appState };\n`,
  );

  const { errors } = runBoundaryCheck(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /imports the app layer via/);
});

test('shared or platform importing the app layer is rejected', async () => {
  await writeSource('app/appState.ts', `export const appState = {};\n`);
  await writeSource(
    'shared/types.ts',
    `import { appState } from '../app/appState.ts';\nexport { appState };\n`,
  );
  await writeSource(
    'platform/tauriApi.ts',
    `import { appState } from '../app/appState.ts';\nexport { appState };\n`,
  );

  const { errors } = runBoundaryCheck(root);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((error) => /imports the app layer via/.test(error)));
});

test('App.tsx importing app/* stays allowed', async () => {
  await writeSource('app/Workspace.tsx', `export default function Workspace() {}\n`);
  await writeSource(
    'App.tsx',
    `import Workspace from './app/Workspace.tsx';\nexport { Workspace };\n`,
  );

  const { errors } = runBoundaryCheck(root);
  assert.deepEqual(errors, []);
});

test('app/* importing another app/* module stays allowed', async () => {
  await writeSource('app/appState.ts', `export const appState = {};\n`);
  await writeSource(
    'app/Workspace.tsx',
    `import { appState } from './appState.ts';\nexport { appState };\n`,
  );

  const { errors } = runBoundaryCheck(root);
  assert.deepEqual(errors, []);
});

test('a feature dependency cycle is detected', async () => {
  await writeSource(
    'features/a/index.ts',
    `import { b } from '../b/index.ts';\nexport const a = b;\n`,
  );
  await writeSource(
    'features/b/index.ts',
    `import { a } from '../a/index.ts';\nexport const b = a;\n`,
  );

  const { errors } = runBoundaryCheck(root);
  assert.equal(
    errors.filter((error) => error.includes('feature dependency cycle detected')).length,
    1,
  );
});

test('reading window.api outside platform and app is rejected', async () => {
  await writeSource('features/sites/useSites.ts', `export const list = () => window.api.sites;\n`);
  await writeSource('components/Icon.tsx', `export const v = window.api.app.version;\n`);
  await writeSource('shared/persist.ts', `export const s = window.api.settings;\n`);

  const { errors } = runBoundaryCheck(root);
  assert.equal(errors.length, 3);
  assert.ok(
    errors.every((error) => /reaches window\.api outside src\/platform and src\/app/.test(error)),
  );
});

test('platform and app may still name window.api', async () => {
  await writeSource('platform/tauriApi.ts', `export const install = () => (window.api = {});\n`);
  await writeSource('app/useAppEffects.ts', `export const v = window.api.app.version;\n`);

  const { errors } = runBoundaryCheck(root);
  assert.deepEqual(errors, []);
});

test('components depending on a feature is rejected even through the public index.ts', async () => {
  await writeSource('features/connections/index.ts', `export const ConnectionBar = 1;\n`);
  await writeSource(
    'components/PaneSourceSwitcher.tsx',
    `import { ConnectionBar } from '../features/connections/index.ts';\n`,
  );

  const { errors } = runBoundaryCheck(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /\(components\) imports feature connections/);
});

test('a cycle routed through an unowned file is detected', async () => {
  // Neither feature imports the other directly: `a` reaches `b` through a
  // shared helper, and `b` reaches `a` through a second one. This is the shape
  // that components/ used to hide.
  await writeSource(
    'features/a/index.ts',
    `import { viaB } from '../../shared/toB.ts';\nexport const a = viaB;\n`,
  );
  await writeSource('shared/toB.ts', `export { b as viaB } from '../features/b/index.ts';\n`);
  await writeSource(
    'features/b/index.ts',
    `import { viaA } from '../../shared/toA.ts';\nexport const b = viaA;\n`,
  );
  await writeSource('shared/toA.ts', `export { a as viaA } from '../features/a/index.ts';\n`);

  const { errors } = runBoundaryCheck(root);
  assert.ok(errors.some((error) => error.includes('feature dependency cycle detected')));
});

test('two features sharing one helper is not a cycle', async () => {
  await writeSource('shared/format.ts', `export const format = (v: string) => v;\n`);
  await writeSource(
    'features/a/index.ts',
    `import { format } from '../../shared/format.ts';\nexport const a = format;\n`,
  );
  await writeSource(
    'features/b/index.ts',
    `import { format } from '../../shared/format.ts';\nexport const b = format;\n`,
  );

  const { errors } = runBoundaryCheck(root);
  assert.deepEqual(errors, []);
});

test('a module sitting directly in src/ is rejected', async () => {
  await writeSource('utils.ts', `export const formatBytes = (n: number) => String(n);\n`);

  const { errors } = runBoundaryCheck(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /utils\.ts sits in src\/ itself/);
});

test('the two entry points may sit in src/ and reach the app layer', async () => {
  await writeSource('app/Application.tsx', `export default function Application() {}\n`);
  await writeSource('App.tsx', `import Application from './app/Application.tsx';\n`);
  await writeSource('main.tsx', `import App from './App.tsx';\n`);

  const { errors } = runBoundaryCheck(root);
  assert.deepEqual(errors, []);
});
