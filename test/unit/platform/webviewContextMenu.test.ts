import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('WebView cancels its default menu and still dispatches the app context menu', () => {
  const script = readFileSync(
    new URL('../../../src-tauri/assets/disable_context_menu.js', import.meta.url),
    'utf8',
  );
  const { window } = new JSDOM('<input><button>File</button>', { runScripts: 'outside-only' });
  try {
    window.eval(script);
    const document = window.document;
    const button = document.querySelector('button')!;
    let handled = false;
    button.addEventListener('contextmenu', (event) => {
      handled = true;
      event.stopPropagation();
    });
    for (const target of [document.body, document.querySelector('input')!, button]) {
      const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      assert.equal(target.dispatchEvent(event), false, target.localName);
    }
    assert.equal(handled, true);
  } finally {
    window.close();
  }
});
