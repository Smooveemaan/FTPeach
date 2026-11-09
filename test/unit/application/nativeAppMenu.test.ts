import assert from 'node:assert/strict';
import test from 'node:test';

import { macDisplayToMuda } from '../../../src/app/useNativeAppMenu.ts';

test('macDisplayToMuda parses macOS shortcut representations into muda accelerators', () => {
  assert.equal(macDisplayToMuda('⌘T'), 'Cmd+T');
  assert.equal(macDisplayToMuda('⌘N'), 'Cmd+N');
  assert.equal(macDisplayToMuda('⌘W'), 'Cmd+W');
  assert.equal(macDisplayToMuda('⌘R'), 'Cmd+R');
  assert.equal(macDisplayToMuda('⇧⌘T'), 'Cmd+Shift+T');
  assert.equal(macDisplayToMuda('⇧⌘N'), 'Cmd+Shift+N');
  assert.equal(macDisplayToMuda('⇧⌘S'), 'Cmd+Shift+S');
  assert.equal(macDisplayToMuda('⌘,'), 'Cmd+Comma');
  assert.equal(macDisplayToMuda('⇧⌘.'), 'Cmd+Shift+Period');
  assert.equal(macDisplayToMuda('⌥⌘T'), 'Cmd+Alt+T');
  assert.equal(macDisplayToMuda('⌘Return'), 'Cmd+Enter');
  assert.equal(macDisplayToMuda('⌃⌘A'), 'Cmd+Ctrl+A');
  assert.equal(macDisplayToMuda('Ctrl+Shift+T'), 'Ctrl+Shift+T');
});

test('macDisplayToMuda handles empty, missing, or bare strings safely', () => {
  assert.equal(macDisplayToMuda(undefined), undefined);
  assert.equal(macDisplayToMuda(''), undefined);
  assert.equal(macDisplayToMuda('   '), undefined);
});
