import { getCurrentWebview } from '@tauri-apps/api/webview';

/**
 * Interface scale: one owner for the write and the read.
 *
 * The scale reaches layout code as a CSS custom property, which is a global
 * channel like any other -- so the writer and every reader belong in the same
 * module. Splitting the reader into a second file (it lived in
 * `src/utils/readInterfaceScale.ts`) hid that they are one contract: the name
 * of the property appeared in two places that nothing tied together.
 */
export function clampInterfaceScale(percent: number): number {
  return Number.isNaN(percent) ? 1 : Math.min(1.5, Math.max(0.8, percent / 100));
}

export async function applyInterfaceScale(percent: number): Promise<void> {
  const scale = clampInterfaceScale(percent);
  document.documentElement.style.setProperty('--interface-scale', '1');
  document.documentElement.dataset.interfaceScale = String(Math.round(scale * 100));
  if ('__TAURI_INTERNALS__' in window) {
    await getCurrentWebview().setZoom(scale);
  }
}

/**
 * The scale layout maths must divide by, defaulting to 1 whenever the property
 * is missing or unusable -- an unstyled test root, or a value CSS accepted but
 * `parseFloat` cannot use.
 */
export function getInterfaceScale(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--interface-scale');
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}
