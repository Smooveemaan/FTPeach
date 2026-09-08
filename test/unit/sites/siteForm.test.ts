import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canSubmitSiteForm,
  createSiteForm,
  normalizeSiteForm,
} from '../../../src/features/sites/siteForm.ts';
import { siteManagerDialogReducer } from '../../../src/features/sites/useSiteManagerDialogState.ts';
import type { SiteManagerDialogState } from '../../../src/features/sites/useSiteManagerDialogState.ts';

test('site form normalization trims persisted fields and preserves secret intent', () => {
  const form = createSiteForm({
    id: 'site-1',
    name: 'Old',
    protocol: 'sftp',
    hasPassword: true,
    parentId: 'folder-1',
  });
  const payload = normalizeSiteForm(
    { ...form, name: '  New  ', host: ' host ', user: ' user ', port: '' },
    'site-1',
  );
  assert.equal(payload.name, 'New');
  assert.equal(payload.host, 'host');
  assert.equal(payload.user, 'user');
  assert.equal(payload.port, 22);
  assert.equal(payload.parentId, 'folder-1');
  assert.equal(payload.password, '');
  assert.equal(payload.removePassword, false);
});

test('site form validation switches its required address by protocol', () => {
  assert.equal(canSubmitSiteForm({ ...createSiteForm(), name: 'FTP', host: 'example.test' }), true);
  assert.equal(
    canSubmitSiteForm({ ...createSiteForm(), name: 'DAV', protocol: 'webdav', host: 'ignored' }),
    false,
  );
});

test('site form validation rejects ports outside the TCP range', () => {
  const valid = { ...createSiteForm(), name: 'FTP', host: 'example.test' };
  assert.equal(canSubmitSiteForm({ ...valid, port: '' }), true);
  assert.equal(canSubmitSiteForm({ ...valid, port: '22' }), true);
  assert.equal(canSubmitSiteForm({ ...valid, port: '0' }), false);
  assert.equal(canSubmitSiteForm({ ...valid, port: '65536' }), false);
  assert.equal(canSubmitSiteForm({ ...valid, port: 'abc' }), false);
});

test('site manager dialog reducer supports atomic modal transitions and functional updates', () => {
  const initialState: SiteManagerDialogState = {
    editingId: null,
    form: createSiteForm(),
    error: 'old',
    saving: false,
    pendingDelete: null,
    addingFolder: false,
    newFolderName: '',
    renamingFolderId: null,
    renameFolderName: '',
    renamingSiteId: null,
    renameSiteName: '',
  };
  const editing = siteManagerDialogReducer(initialState, {
    type: 'patch',
    value: { editingId: 'site-1', error: '' },
  });
  assert.deepEqual(editing, { ...initialState, editingId: 'site-1', error: '' });
  assert.equal(
    siteManagerDialogReducer(editing, {
      type: 'set',
      key: 'editingId',
      value: (id: string | null) => `${id}-copy`,
    }).editingId,
    'site-1-copy',
  );
});
