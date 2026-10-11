/** Default first, then neutral shades and warm hues through greens, blues and violet to rose. */
export const COLOR_SCHEMES = [
  'peach',
  'black',
  'gray',
  'graphite',
  'linen',
  'sand',
  'cocoa',
  'ember',
  'clay',
  'leaves',
  'forest',
  'solarized',
  'nord',
  'ocean',
  'midnight',
  'catppuccin',
  'dracula',
  'plum',
  'burgundy',
  'rose',
] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

/** Unknown stored schemes keep the original appearance. */
export function normalizeColorScheme(value: unknown): ColorScheme {
  return COLOR_SCHEMES.find((scheme) => scheme === value) ?? 'peach';
}

/** Applies the same CSS tokens to the main document and isolated confirmations. */
export function applyAppearance(theme: string, colorScheme: unknown): void {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.colorScheme = normalizeColorScheme(colorScheme);
}
