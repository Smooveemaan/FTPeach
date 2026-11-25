import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTerminalTheme } from '../../../src/features/terminal/index.ts';

describe('buildTerminalTheme', () => {
  it('derives chrome colors and rgba selection from CSS variables without color-mix', () => {
    const vars: Record<string, string> = {
      '--bg-base': '#101010',
      '--bg-raised': '#222222',
      '--text-primary': '#f0f0f0',
      '--text-secondary': '#cccccc',
      '--text-faint': '#777777',
      '--accent-primary': '#ff9966',
      '--accent-primary-border': 'color-mix(in srgb, #ff9966 26%, transparent)',
    };
    const dark = buildTerminalTheme((name) => vars[name] ?? '', false);
    assert.equal(dark.background, '#101010');
    assert.equal(dark.foreground, '#f0f0f0');
    assert.equal(dark.cursor, '#ff9966');
    assert.equal(dark.cursorAccent, '#101010');
    assert.equal(dark.black, '#222222');
    assert.equal(dark.selectionBackground, 'rgba(255, 153, 102, 0.32)');
    assert.equal(dark.selectionInactiveBackground, 'rgba(255, 153, 102, 0.16)');

    const light = buildTerminalTheme((name) => vars[name] ?? '', true);
    assert.equal(light.selectionBackground, 'rgba(255, 153, 102, 0.35)');
    assert.equal(light.selectionInactiveBackground, 'rgba(255, 153, 102, 0.18)');
  });

  it('uses distinct light and dark fallbacks when variables are empty', () => {
    const dark = buildTerminalTheme(() => '', false);
    const light = buildTerminalTheme(() => '', true);
    assert.notEqual(dark.background, light.background);
    assert.notEqual(dark.foreground, light.foreground);
    assert.notEqual(dark.blue, light.blue);
    assert.notEqual(dark.brightBlue, light.brightBlue);
    assert.equal(light.black, light.foreground);
  });

  it('applies canonical ANSI-16 palettes for community color schemes', () => {
    const baseDark = buildTerminalTheme(() => '', false, 'peach');
    const draculaDark = buildTerminalTheme(() => '', false, 'dracula');
    const catppuccinDark = buildTerminalTheme(() => '', false, 'catppuccin');
    const catppuccinLight = buildTerminalTheme(() => '', true, 'catppuccin');
    const nordDark = buildTerminalTheme(() => '', false, 'nord');
    const solarizedDark = buildTerminalTheme(() => '', false, 'solarized');

    assert.equal(draculaDark.blue, '#bd93f9');
    assert.equal(catppuccinDark.blue, '#89b4fa');
    assert.equal(catppuccinLight.blue, '#1e66f5');
    assert.equal(nordDark.blue, '#81a1c1');
    assert.equal(solarizedDark.blue, '#268bd2');
    assert.notEqual(baseDark.blue, draculaDark.blue);
  });
});
