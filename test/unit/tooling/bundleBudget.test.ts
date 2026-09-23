import assert from 'node:assert/strict';
import test from 'node:test';
import { startupGraphs } from '../../../scripts/checks/check-bundle-budget.ts';
import type { ViteManifest } from '../../../scripts/checks/check-bundle-budget.ts';

const manifest = (): ViteManifest => ({
  'index.html': {
    file: 'index.js',
    isEntry: true,
    imports: ['_react.js'],
    css: ['index.css'],
    dynamicImports: [
      'node_modules/react-dom/client.js',
      'src/App.tsx',
      'src/platform/tauriApi.ts',
      'src/platform/SecurityConfirmation.tsx',
      'src/features/settings/SettingsDialog.tsx',
    ],
  },
  '_react.js': { file: 'react.js' },
  'node_modules/react-dom/client.js': { file: 'client.js', imports: ['_react.js'] },
  'src/App.tsx': { file: 'App.js', imports: ['_react.js', '_shared.js'] },
  '_shared.js': { file: 'shared.js' },
  'src/platform/tauriApi.ts': { file: 'tauriApi.js', imports: ['_shared.js'] },
  'src/platform/SecurityConfirmation.tsx': {
    file: 'SecurityConfirmation.js',
    css: ['SecurityConfirmation.css'],
  },
  'src/features/settings/SettingsDialog.tsx': { file: 'Settings.js', imports: ['_shared.js'] },
});

test('each window counts its awaited imports and their static graph once', () => {
  const graphs = startupGraphs(manifest());
  assert.deepEqual([...graphs.main!].sort(), [
    'App.js',
    'client.js',
    'index.css',
    'index.js',
    'react.js',
    'shared.js',
    'tauriApi.js',
  ]);
  assert.deepEqual([...graphs.securityConfirmation!].sort(), [
    'SecurityConfirmation.css',
    'SecurityConfirmation.js',
    'client.js',
    'index.css',
    'index.js',
    'react.js',
  ]);
  // A screen opened later is deferred, even though it shares a chunk.
  assert.ok(![...graphs.main!].includes('Settings.js'));
});

test('a chunk a startup import pulls in statically joins the startup graph', () => {
  const grown = manifest();
  grown['src/App.tsx']!.imports!.push('_big.js');
  grown['_big.js'] = { file: 'big.js' };
  assert.ok(startupGraphs(grown).main!.has('big.js'));
});

test('a startup import that is no longer dynamic stops the check instead of dropping out', () => {
  const moved = manifest();
  moved['index.html']!.dynamicImports = moved['index.html']!.dynamicImports!.filter(
    (key) => key !== 'src/App.tsx',
  );
  assert.throws(() => startupGraphs(moved), /no longer imports src\/App.tsx dynamically/);
});
