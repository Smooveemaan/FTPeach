import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTerminalKey } from '../../../src/features/terminal/index.ts';
import type { TerminalKeyInput } from '../../../src/features/terminal/index.ts';

function key(overrides: Partial<TerminalKeyInput> = {}): TerminalKeyInput {
  return {
    code: '',
    key: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe('classifyTerminalKey', () => {
  it('routes smart Ctrl+C, Ctrl+V, Ctrl+Shift+C/V and Insert combos on Windows and Linux', () => {
    for (const platform of ['windows', 'linux'] as const) {
      assert.equal(
        classifyTerminalKey(key({ code: 'KeyC', ctrlKey: true }), platform, false),
        'pty',
      );
      assert.equal(
        classifyTerminalKey(key({ code: 'KeyC', ctrlKey: true }), platform, true),
        'copy',
      );
      assert.equal(classifyTerminalKey(key({ code: 'KeyV', ctrlKey: true }), platform), 'paste');
      assert.equal(classifyTerminalKey(key({ code: 'KeyR', ctrlKey: true }), platform), 'pty');
      assert.equal(classifyTerminalKey(key({ code: 'KeyW', ctrlKey: true }), platform), 'pty');
      assert.equal(classifyTerminalKey(key({ code: 'KeyF', ctrlKey: true }), platform), 'pty');
      assert.equal(classifyTerminalKey(key({ code: 'F5' }), platform), 'pty');

      assert.equal(
        classifyTerminalKey(key({ code: 'KeyC', ctrlKey: true, shiftKey: true }), platform),
        'copy',
      );
      assert.equal(classifyTerminalKey(key({ code: 'Insert', ctrlKey: true }), platform), 'copy');
      assert.equal(
        classifyTerminalKey(key({ code: 'KeyV', ctrlKey: true, shiftKey: true }), platform),
        'paste',
      );
      assert.equal(classifyTerminalKey(key({ code: 'Insert', shiftKey: true }), platform), 'paste');
    }
  });

  it('uses Cmd shortcuts for terminal UI and keeps Ctrl chords for PTY on macOS', () => {
    assert.equal(classifyTerminalKey(key({ code: 'KeyC', metaKey: true }), 'macos'), 'copy');
    assert.equal(classifyTerminalKey(key({ code: 'KeyV', metaKey: true }), 'macos'), 'paste');
    assert.equal(classifyTerminalKey(key({ code: 'KeyA', metaKey: true }), 'macos'), 'select-all');
    assert.equal(classifyTerminalKey(key({ code: 'KeyK', metaKey: true }), 'macos'), 'clear');
    assert.equal(
      classifyTerminalKey(key({ code: 'KeyR', metaKey: true }), 'macos'),
      'prevent-browser',
    );
    assert.equal(
      classifyTerminalKey(key({ code: 'KeyF', metaKey: true }), 'macos'),
      'prevent-browser',
    );

    assert.equal(classifyTerminalKey(key({ code: 'KeyC', ctrlKey: true }), 'macos', true), 'pty');
    assert.equal(classifyTerminalKey(key({ code: 'KeyR', ctrlKey: true }), 'macos'), 'pty');
    assert.equal(classifyTerminalKey(key({ code: 'KeyW', ctrlKey: true }), 'macos'), 'pty');
    assert.equal(classifyTerminalKey(key({ code: 'KeyD', ctrlKey: true }), 'macos'), 'pty');
  });

  it('passes tab switching and DevTools shortcuts through to the application on all platforms', () => {
    for (const platform of ['windows', 'linux', 'macos'] as const) {
      assert.equal(
        classifyTerminalKey(key({ code: 'Tab', key: 'Tab', ctrlKey: true }), platform),
        'pass-through-app',
      );
      assert.equal(
        classifyTerminalKey(
          key({ code: 'Tab', key: 'Tab', ctrlKey: true, shiftKey: true }),
          platform,
        ),
        'pass-through-app',
      );
      assert.equal(classifyTerminalKey(key({ code: 'F12' }), platform), 'pass-through-app');
    }
    assert.equal(
      classifyTerminalKey(key({ code: 'KeyI', altKey: true, metaKey: true }), 'macos'),
      'pass-through-app',
    );
  });
});
