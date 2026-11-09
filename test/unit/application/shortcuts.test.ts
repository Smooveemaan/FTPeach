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
import {
  actionDefault,
  effectiveBinding,
  findConflicts,
  resolveAction,
} from '../../../src/shortcuts/resolve.ts';
import { normalizeKeyboardShortcuts } from '../../../src/features/settings/useSettings.ts';
import { resolveDropAction } from '../../../src/features/file-browser/components/dropAction.ts';
import { makePane } from '../../../src/features/file-browser/panes/paneModel.ts';

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
  // Ctrl and Meta are merged into a single "primary modifier" on non-macOS — matching
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

test('findConflicts lists every action sharing a binding, across global and pane scopes', () => {
  const overrides = { paste: 'F5' }; // pane-scope 'paste' now collides with global-scope 'refresh'
  assert.deepEqual(findConflicts('refresh', 'F5', overrides), ['paste']);
  assert.deepEqual(findConflicts('paste', 'F5', overrides), ['refresh']);

  const sameScope = { paste: 'Ctrl+KeyC' }; // collides with pane-scope 'copy'
  assert.deepEqual(findConflicts('paste', 'Ctrl+KeyC', sameScope), ['copy']);

  const twice = { paste: 'Ctrl+KeyC', rename: 'Ctrl+KeyC' };
  assert.deepEqual(findConflicts('paste', 'Ctrl+KeyC', twice).sort(), ['copy', 'rename']);
});

test('normalizeKeyboardShortcuts drops unknown ids and malformed bindings, keeps valid overrides and explicit unbinds', () => {
  const normalized = normalizeKeyboardShortcuts({
    refresh: 'Ctrl+KeyR',
    rename: '',
    'not-a-real-action': 'KeyA',
    'new-tab': 'Meta+KeyT', // 'Meta' isn't a recognized modifier name (Ctrl/Alt/Shift/Cmd only)
  });
  assert.deepEqual(normalized, { refresh: 'Ctrl+KeyR', rename: '' });
  assert.deepEqual(normalizeKeyboardShortcuts(null), {});
  assert.deepEqual(normalizeKeyboardShortcuts([]), {});
});

test('macOS default bindings and formatting round-trip', () => {
  for (const action of SHORTCUT_ACTIONS) {
    const macBinding = actionDefault(action, 'macos');
    assert.ok(macBinding, `macOS binding for ${action.id} should be defined`);
    const parsed = parseBinding(macBinding);
    assert.ok(parsed, `macOS binding ${macBinding} for ${action.id} should parse`);
    const event = fakeEvent({
      code: parsed.code,
      ctrlKey: parsed.ctrl,
      altKey: parsed.alt,
      shiftKey: parsed.shift,
      metaKey: parsed.cmd,
    });
    assert.equal(bindingFromEvent(event, 'macos'), macBinding);
    assert.ok(matchesBinding(event, macBinding, 'macos'));
    assert.ok(formatBinding(macBinding, 'macos').length > 0);
  }
});

test('bindingFromEvent separates Cmd and Ctrl on macOS', () => {
  assert.equal(
    bindingFromEvent(fakeEvent({ code: 'KeyF', metaKey: true }), 'macos'),
    'Cmd+KeyF',
  );
  assert.equal(
    bindingFromEvent(fakeEvent({ code: 'KeyF', ctrlKey: true }), 'macos'),
    'Ctrl+KeyF',
  );
  assert.equal(
    bindingFromEvent(fakeEvent({ code: 'KeyF', metaKey: true, shiftKey: true }), 'macos'),
    'Shift+Cmd+KeyF',
  );
  assert.equal(
    bindingFromEvent(fakeEvent({ code: 'KeyV', metaKey: true, altKey: true }), 'macos'),
    'Alt+Cmd+KeyV',
  );
  assert.equal(
    bindingFromEvent(fakeEvent({ code: 'Tab', ctrlKey: true }), 'macos'),
    'Ctrl+Tab',
  );
});

test('formatBinding displays macOS modifier symbols in ⌃⌥⇧⌘ order and replaces special keys', () => {
  assert.equal(formatBinding('Cmd+KeyF', 'macos'), '⌘F');
  assert.equal(formatBinding('Shift+Cmd+KeyF', 'macos'), '⇧⌘F');
  assert.equal(formatBinding('Shift+Cmd+Period', 'macos'), '⇧⌘.');
  assert.equal(formatBinding('Cmd+Comma', 'macos'), '⌘,');
  assert.equal(formatBinding('Ctrl+Tab', 'macos'), '⌃Tab');
  assert.equal(formatBinding('Ctrl+Shift+Tab', 'macos'), '⌃⇧Tab');
  assert.equal(formatBinding('Shift+Cmd+BracketRight', 'macos'), '⇧⌘]');
  assert.equal(formatBinding('Shift+Cmd+BracketLeft', 'macos'), '⇧⌘[');
  assert.equal(formatBinding('Enter', 'macos'), 'Return');
  assert.equal(formatBinding('Cmd+ArrowDown', 'macos'), '⌘↓');
  assert.equal(formatBinding('Cmd+ArrowUp', 'macos'), '⌘↑');
  assert.equal(formatBinding('Cmd+Backspace', 'macos'), '⌘⌫');
  assert.equal(formatBinding('Alt+Cmd+Backspace', 'macos'), '⌥⌘⌫');
  assert.equal(formatBinding('Alt+Cmd+KeyV', 'macos'), '⌥⌘V');
  assert.equal(formatBinding('Shift+Cmd+KeyM', 'macos'), '⇧⌘M');
  assert.equal(formatBinding('Shift+Cmd+KeyN', 'macos'), '⇧⌘N');
  assert.equal(formatBinding('Alt+Cmd+KeyN', 'macos'), '⌥⌘N');
  assert.equal(formatBinding('Alt+Cmd+KeyC', 'macos'), '⌥⌘C');
  assert.equal(formatBinding('Shift+Cmd+KeyH', 'macos'), '⇧⌘H');
});

test('resolveAction resolves macOS defaults and aliases', () => {
  // Defaults on macOS
  assert.equal(resolveAction(fakeEvent({ code: 'KeyF', metaKey: true }), 'global', {}, 'macos'), 'search-local');
  assert.equal(resolveAction(fakeEvent({ code: 'KeyF', metaKey: true, shiftKey: true }), 'global', {}, 'macos'), 'search-remote');
  assert.equal(resolveAction(fakeEvent({ code: 'KeyR', metaKey: true }), 'global', {}, 'macos'), 'refresh');
  assert.equal(resolveAction(fakeEvent({ code: 'Enter' }), 'pane', {}, 'macos'), 'rename');
  assert.equal(resolveAction(fakeEvent({ code: 'ArrowDown', metaKey: true }), 'pane', {}, 'macos'), 'open');
  assert.equal(resolveAction(fakeEvent({ code: 'Backspace', metaKey: true }), 'pane', {}, 'macos'), 'delete');
  assert.equal(resolveAction(fakeEvent({ code: 'Backspace', metaKey: true, altKey: true }), 'pane', {}, 'macos'), 'delete-permanent');

  // Aliases on macOS
  assert.equal(resolveAction(fakeEvent({ code: 'F5' }), 'global', {}, 'macos'), 'refresh');
  assert.equal(resolveAction(fakeEvent({ code: 'F2' }), 'pane', {}, 'macos'), 'rename');
  assert.equal(resolveAction(fakeEvent({ code: 'KeyO', metaKey: true }), 'pane', {}, 'macos'), 'open');
  assert.equal(resolveAction(fakeEvent({ code: 'BracketRight', metaKey: true, shiftKey: true }), 'global', {}, 'macos'), 'next-tab');
  assert.equal(resolveAction(fakeEvent({ code: 'BracketLeft', metaKey: true, shiftKey: true }), 'global', {}, 'macos'), 'prev-tab');
  assert.equal(resolveAction(fakeEvent({ code: 'F6' }), 'pane', {}, 'macos'), 'move-to');
  assert.equal(resolveAction(fakeEvent({ code: 'F7' }), 'pane', {}, 'macos'), 'new-folder');
  assert.equal(resolveAction(fakeEvent({ code: 'F7', shiftKey: true }), 'pane', {}, 'macos'), 'new-file');
  assert.equal(resolveAction(fakeEvent({ code: 'F8' }), 'pane', {}, 'macos'), 'copy-to-other-pane');
});

test('resolveDropAction respects macOS Option key for copying', () => {
  const source = {
    ...makePane('a', 'local'),
    path: 'C:\\work',
    entries: [{ name: 'folder', isDirectory: true, size: 0 }],
  };
  const target = { ...makePane('b', 'local'), path: 'C:\\other' };

  // Windows: ctrlKey copies, altKey does not
  assert.equal(
    resolveDropAction(source, target, null, ['folder'], { ctrlKey: false, shiftKey: false, altKey: true }, 'windows'),
    'move',
  );
  assert.equal(
    resolveDropAction(source, target, null, ['folder'], { ctrlKey: true, shiftKey: false }, 'windows'),
    'copy',
  );

  // macOS: altKey copies, ctrlKey does not
  assert.equal(
    resolveDropAction(source, target, null, ['folder'], { ctrlKey: false, shiftKey: false, altKey: true }, 'macos'),
    'copy',
  );
  assert.equal(
    resolveDropAction(source, target, null, ['folder'], { ctrlKey: true, shiftKey: false, altKey: false }, 'macos'),
    'move',
  );
});
