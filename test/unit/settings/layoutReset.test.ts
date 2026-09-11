import assert from 'node:assert/strict';
import test from 'node:test';

import SETTINGS_DEFAULTS from '../../../src/shared/settingsDefaults.ts';
import { resetLayoutFromApi } from '../../../src/features/settings/layoutReset.ts';

type LayoutResetTargets = Parameters<typeof resetLayoutFromApi>[1];

interface Recorded {
  layout: Record<string, unknown>;
  hydrated: unknown;
  touched: boolean;
}

function recordingTargets(): { targets: LayoutResetTargets; recorded: Recorded } {
  const recorded: Recorded = { layout: {}, hydrated: undefined, touched: false };
  const targets: LayoutResetTargets = {
    updateLayout: (patch) => {
      Object.assign(recorded.layout, patch);
      recorded.touched = true;
    },
    hydrateSectionResizeFromSettings: (settings) => {
      recorded.hydrated = settings;
      recorded.touched = true;
    },
  };
  return { targets, recorded };
}

test('reset layout applies persisted backend settings and normalizes legacy columns', async () => {
  const settings = {
    localColumns: ['size'],
    remoteColumns: { a: ['modifiedAt'], b: ['size'] },
    localColumnWidths: { size: 180 },
    remoteColumnWidths: { a: { size: 220 }, b: {} },
    transferColumnWidths: { name: 320 },
    transferColumnOrder: ['status', 'size'],
    transferHiddenColumns: ['route'],
    showLocalPane: false,
    showRemotePane: true,
    showTransferQueue: false,
    paneOrientation: 'vertical',
    splitRatio: 0.4,
  };
  const { targets, recorded } = recordingTargets();

  const result = await resetLayoutFromApi(
    { resetLayout: async () => ({ ok: true, settings }) },
    targets,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(recorded.layout.localColumns, { a: ['size'], b: ['size'] });
  assert.deepEqual(recorded.layout.remoteColumns, settings.remoteColumns);
  assert.deepEqual(recorded.layout.localColumnWidths, {
    a: { size: 180 },
    b: { size: 180 },
  });
  assert.deepEqual(recorded.layout.transferColumnWidths, { name: 320 });
  assert.deepEqual(recorded.layout.transferColumnOrder, ['status', 'size']);
  assert.deepEqual(recorded.layout.transferHiddenColumns, ['route']);
  assert.equal(recorded.layout.showLocalPane, false);
  assert.equal(recorded.layout.showRemotePane, true);
  assert.equal(recorded.layout.showTransferQueue, false);
  assert.equal(recorded.layout.paneOrientation, 'vertical');
  assert.equal(recorded.hydrated, settings);
});

test('reset layout leaves renderer state untouched when backend reset fails', async () => {
  const { targets, recorded } = recordingTargets();
  const failure = { ok: false, error: 'reset failed' };

  const result = await resetLayoutFromApi({ resetLayout: async () => failure }, targets);

  assert.equal(result, failure);
  assert.equal(recorded.touched, false);
});

test('reset layout falls back to frontend defaults for missing layout fields', async () => {
  const { targets, recorded } = recordingTargets();

  await resetLayoutFromApi({ resetLayout: async () => ({ ok: true, settings: {} }) }, targets);

  assert.deepEqual(recorded.layout.localColumns, SETTINGS_DEFAULTS.localColumns);
  assert.deepEqual(recorded.layout.remoteColumnWidths, SETTINGS_DEFAULTS.remoteColumnWidths);
  assert.deepEqual(recorded.layout.transferColumnWidths, SETTINGS_DEFAULTS.transferColumnWidths);
  assert.deepEqual(recorded.layout.transferColumnOrder, SETTINGS_DEFAULTS.transferColumnOrder);
  assert.deepEqual(recorded.layout.transferHiddenColumns, []);
  assert.equal(recorded.layout.showLocalPane, true);
  assert.equal(recorded.layout.showRemotePane, true);
  assert.equal(recorded.layout.showTransferQueue, true);
  assert.equal(recorded.layout.paneOrientation, SETTINGS_DEFAULTS.paneOrientation);
});
