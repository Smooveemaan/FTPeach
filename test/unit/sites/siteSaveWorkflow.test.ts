import assert from 'node:assert/strict';
import test from 'node:test';
import { initialForm } from '../../../src/features/file-browser/panes/paneModel.ts';
import { createPaneSiteForm, normalizeSiteForm } from '../../../src/features/sites/siteForm.ts';
import { savedSiteLinkForPane } from '../../../src/features/sites/useSiteSaveWorkflow.ts';

const pane = {
  kind: 'remote' as const,
  form: { ...initialForm, protocol: 'sftp' as const, host: 'example.test', port: '', user: 'me' },
  path: '/srv',
};

const savedAs = (name: string, overrides = {}) =>
  normalizeSiteForm({ ...createPaneSiteForm(pane), name, ...overrides }, '__new__');

test('saving the pane connection links the pane to the new bookmark by name', () => {
  assert.deepEqual(savedSiteLinkForPane(pane, savedAs('Production'), { ok: true, id: 'site-1' }), {
    siteId: 'site-1',
    siteLabel: 'Production',
  });
});

test('a bookmark for another destination leaves the pane unlinked', () => {
  assert.equal(
    savedSiteLinkForPane(pane, savedAs('Staging', { host: 'staging.test' }), {
      ok: true,
      id: 'site-2',
    }),
    null,
  );
});

test('a failed save, or one without an id, leaves the pane unlinked', () => {
  assert.equal(savedSiteLinkForPane(pane, savedAs('Production'), { ok: false }), null);
  assert.equal(savedSiteLinkForPane(pane, savedAs('Production'), { ok: true }), null);
  assert.equal(savedSiteLinkForPane(pane, savedAs('Production'), undefined), null);
});
