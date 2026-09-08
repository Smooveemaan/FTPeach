import assert from 'node:assert/strict';
import test from 'node:test';

import { SHORTCUT_ACTIONS } from '../../../src/shortcuts/registry.ts';
import {
  bindingFromEvent,
  formatBinding,
  isValidBinding,
  matchesBinding,
  parseBinding,
} from '../../../src/shortcuts/bindings.ts';
import type { ShortcutKeyboardEvent } from '../../../src/shortcuts/bindings.ts';
import { effectiveBinding, findConflict, resolveAction } from '../../../src/shortcuts/resolve.ts';
import { normalizeKeyboardShortcuts } from '../../../src/features/settings/useSettings.ts';

function fakeEvent({
  code,
  ctrlKey = false,
  shiftKey = false,
  altKey = false,
  metaKey = false,
}: Partial<ShortcutKeyboardEvent> & Pick<ShortcutKeyboardEvent, 'code'>): ShortcutKeyboardEvent {
  return { code, ctrlKey, shiftKey, altKey, metaKey };
}

test('bindingFromEvent/matchesBinding/formatBinding/parseBinding round-trip every default binding', () => {
  for (const action of SHORTCUT_ACTIONS) {
    const parsed = parseBinding(action.default);
    assert.ok(parsed, `default binding for ${action.id} should be valid`);
    const event = fakeEvent({
      code: parsed.code,
      ctrlKey: parsed.ctrl,
      altKey: parsed.alt,
      shiftKey: parsed.shift,
    });
    assert.equal(bindingFromEvent(event), action.default);
    assert.ok(matchesBinding(event, action.default));
    assert.ok(formatBinding(action.default).length > 0);
  }
});

test('bindingFromEvent handles modifier combos', () => {
  assert.equal(
    bindingFromEvent(fakeEvent({ code: 'KeyT', ctrlKey: true, shiftKey: true })),
    'Ctrl+Shift+KeyT',
  );
  assert.equal(bindingFromEvent(fakeEvent({ code: 'ArrowLeft', altKey: true })), 'Alt+ArrowLeft');
  // Ctrl and Meta are merged into a single "primary modifier" — matching
  // the app's existing cross-platform convention.
  assert.equal(bindingFromEvent(fakeEvent({ code: 'KeyT', metaKey: true })), 'Ctrl+KeyT');
});

test('bindingFromEvent returns null for a bare modifier keypress', () => {
  assert.equal(bindingFromEvent(fakeEvent({ code: 'ControlLeft', ctrlKey: true })), null);
  assert.equal(bindingFromEvent(fakeEvent({ code: 'ShiftLeft', shiftKey: true })), null);
  assert.equal(bindingFromEvent(fakeEvent({ code: 'AltRight', altKey: true })), null);
  assert.equal(bindingFromEvent(fakeEvent({ code: 'MetaLeft', metaKey: true })), null);
});

test('isValidBinding rejects malformed strings', () => {
  assert.equal(isValidBinding(''), false);
  assert.equal(isValidBinding('Ctrl+'), false);
  assert.equal(isValidBinding('Ctrl+Ctrl+KeyA'), false);
  assert.equal(isValidBinding('Nonsense+KeyA'), false);
  assert.equal(isValidBinding('KeyA'), true);
  assert.equal(isValidBinding('Ctrl+Shift+KeyA'), true);
});

test('formatBinding produces a readable display string', () => {
  assert.equal(formatBinding('Ctrl+Shift+KeyT'), 'Ctrl+Shift+T');
  assert.equal(formatBinding('Alt+ArrowLeft'), 'Alt+←');
  assert.equal(formatBinding('F5'), 'F5');
  assert.equal(formatBinding(''), '');
});

test('effectiveBinding falls back to default, honors overrides, and treats "" as unbound', () => {
  assert.equal(effectiveBinding('refresh', {}), 'F5');
  assert.equal(effectiveBinding('refresh', undefined), 'F5');
  assert.equal(effectiveBinding('refresh', { refresh: 'Ctrl+KeyR' }), 'Ctrl+KeyR');
  assert.equal(effectiveBinding('refresh', { refresh: '' }), null);
  assert.equal(effectiveBinding('not-a-real-action', {}), null);
});

test('resolveAction resolves an overridden binding and stops matching the old default', () => {
  const overrides = { refresh: 'Ctrl+KeyR' };
  assert.equal(
    resolveAction(fakeEvent({ code: 'KeyR', ctrlKey: true }), 'global', overrides),
    'refresh',
  );
  assert.equal(resolveAction(fakeEvent({ code: 'F5' }), 'global', overrides), null);
});

test('resolveAction only matches actions in the requested scope', () => {
  assert.equal(resolveAction(fakeEvent({ code: 'F2' }), 'global', {}), null);
  assert.equal(resolveAction(fakeEvent({ code: 'F2' }), 'pane', {}), 'rename');
});

test('findConflict flags two same-scope actions sharing a binding, ignores cross-scope overlap', () => {
  const overrides = { paste: 'F5' }; // pane-scope 'paste' now collides with global-scope 'refresh'
  assert.equal(findConflict('refresh', 'F5', 'global', overrides), null);
  assert.equal(findConflict('paste', 'F5', 'pane', overrides), null);

  const sameScope = { paste: 'Ctrl+KeyC' }; // collides with pane-scope 'copy'
  assert.equal(findConflict('paste', 'Ctrl+KeyC', 'pane', sameScope), 'copy');
});

test('normalizeKeyboardShortcuts drops unknown ids and malformed bindings, keeps valid overrides and explicit unbinds', () => {
  const normalized = normalizeKeyboardShortcuts({
    refresh: 'Ctrl+KeyR',
    rename: '',
    'not-a-real-action': 'KeyA',
    'new-tab': 'Meta+KeyT', // 'Meta' isn't a recognized modifier name (Ctrl/Alt/Shift only)
  });
  assert.deepEqual(normalized, { refresh: 'Ctrl+KeyR', rename: '' });
  assert.deepEqual(normalizeKeyboardShortcuts(null), {});
  assert.deepEqual(normalizeKeyboardShortcuts([]), {});
});
