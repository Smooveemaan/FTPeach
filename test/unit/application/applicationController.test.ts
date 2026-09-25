import assert from 'node:assert/strict';
import test from 'node:test';

import {
  associatedApplication,
  connectionVisualState,
} from '../../../src/app/useApplicationController.ts';

test('connection visual state tells transfers, pauses and failures apart', () => {
  assert.equal(connectionVisualState('connected', false, false), 'connected');
  assert.equal(connectionVisualState('connected', false, true), 'paused');
  assert.equal(connectionVisualState('connected', true, true), 'transferring');
  assert.equal(connectionVisualState('connecting', false, true), 'connecting');
  assert.equal(connectionVisualState('error', false, false), 'error');
  assert.equal(connectionVisualState('idle', false, false), 'idle');
});

test('associated application resolves extensions case-insensitively', () => {
  const associations = { txt: 'notepad', gz: 'archive-tool' };

  assert.equal(associatedApplication('/docs/README.TXT', associations), 'notepad');
  assert.equal(associatedApplication('/docs/no-extension', associations), null);
  assert.equal(associatedApplication('/docs/archive.tar.gz', associations), 'archive-tool');
});
