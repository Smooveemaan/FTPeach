import { api } from './api/index.ts';

/**
 * The native window frame: one owner for every color Windows paints outside
 * the client area.
 *
 * None of it is reachable from CSS. The window is frameless
 * (`decorations: false`), so what surrounds it -- the 1px border, the surface
 * a resize exposes before the webview repaints -- belongs to the compositor,
 * and only an IPC call can recolor it. That leaves two states to keep in
 * sync, and they arrive from opposite directions: the theme from settings,
 * and whether a dialog is open from whichever component mounted it. Holding
 * both here is what lets either change alone without the frame going stale,
 * the way `interfaceScale.ts` owns the write and the read of its one property.
 *
 * The colors themselves stay in foundation.css and are read back through
 * `resolveThemeColor`, so a token edit still reaches the frame.
 */

type Channels = [number, number, number];

/** tauri.conf.json's static backgroundColor and the dark --window-border
 * beside it: what the frame falls back to when a token cannot be read. */
const FALLBACK_BASE: Channels = [20, 19, 18];
const FALLBACK_BORDER: Channels = [41, 38, 34];

let preference = 'system';
let openDialogs = 0;

/**
 * Resolves a CSS color expression against the theme now on the document.
 *
 * The frame's colors have to cross into Rust as numbers, but restating them
 * as literals here would give each token a second definition no stylesheet
 * change could reach. A custom property reads back as authored (a hex string
 * today, a `color-mix()` tomorrow), so the value goes through a throwaway
 * element instead: the browser resolves the `var()` and normalizes whatever
 * it finds to rgb() or color(srgb ...) channels.
 */
function resolveThemeColor(value: string, fallback: Channels): Channels {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  probe.style.color = value;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return parseThemeColor(color, fallback);
}

/** Parse browser-normalized RGB and sRGB independently of DOM and IPC. */
export function parseThemeColor(color: string, fallback: Channels): Channels {
  // color-mix(in srgb, ...) stays in color(srgb ...) form in the webview.
  // Its channels are normalized to 0..1 rather than RGB's 0..255.
  const srgb = color.match(
    /^color\(srgb\s+([+-]?[\d.eE+-]+)\s+([+-]?[\d.eE+-]+)\s+([+-]?[\d.eE+-]+)(?:\s*\/\s*([\d.]+))?\s*\)$/i,
  );
  const channels =
    srgb ??
    color.match(
      /^rgba?\(\s*([+-]?[\d.]+)[,\s]+([+-]?[\d.]+)[,\s]+([+-]?[\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i,
    );
  if (!channels || Number(channels[4] ?? 1) === 0) return fallback;
  const values = channels.slice(1, 4).map((value) => Number(value) * (srgb ? 255 : 1));
  if (!values.every(Number.isFinite)) return fallback;
  const channel = (index: number) => Math.min(255, Math.max(0, Math.round(values[index]!)));
  return [channel(0), channel(1), channel(2)];
}

function push(): void {
  // Outside Tauri there is no native frame to color: the visual-test renderer
  // and the component tests both mount this UI in a plain browser, where
  // `window.api` was never installed. Same guard, same reason, as the zoom
  // call in interfaceScale.ts.
  if (!('__TAURI_INTERNALS__' in window)) return;
  const border = openDialogs > 0 ? 'var(--window-border-dimmed)' : 'var(--window-border)';
  api.app.setWindowTheme(preference, {
    background: resolveThemeColor('var(--bg-base)', FALLBACK_BASE),
    border: resolveThemeColor(border, FALLBACK_BORDER),
  });
}

/**
 * Called with the raw preference, not the theme it resolves to: 'system' has
 * to reach the native side as such, so the OS keeps choosing for the window
 * exactly as `prefers-color-scheme` keeps choosing for the CSS. The colors
 * are read off the document, which is already resolved either way.
 */
export function applyWindowTheme(themePreference: string): void {
  preference = themePreference;
  push();
}

/**
 * Dims the frame for as long as a dialog is open, matching the scrim the
 * overlay paints over the app and `.title-bar::after` paints over the bar.
 * Returns the release, so a caller can pair it with the mount that took it;
 * dialogs stack, hence a depth rather than a flag.
 */
export function holdDialogScrim(): () => void {
  openDialogs += 1;
  if (openDialogs === 1) push();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openDialogs -= 1;
    if (openDialogs === 0) push();
  };
}
