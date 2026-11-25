export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export type CssVarReader = (name: string) => string;

interface AnsiChromaticPalette {
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
}

const DARK_CHROME_FALLBACKS = {
  bgBase: '#141312',
  bgRaised: '#2b2824',
  textPrimary: '#f3eee7',
  textSecondary: '#bcb5ad',
  textFaint: '#817a73',
  accentPrimary: '#ff9d72',
  selection: 'rgba(255, 157, 114, 0.32)',
  selectionInactive: 'rgba(255, 157, 114, 0.16)',
};

const LIGHT_CHROME_FALLBACKS = {
  bgBase: '#faf9f7',
  bgRaised: '#e2ded8',
  textPrimary: '#27231f',
  textSecondary: '#665f58',
  textFaint: '#8e867e',
  accentPrimary: '#e87852',
  selection: 'rgba(232, 120, 82, 0.35)',
  selectionInactive: 'rgba(232, 120, 82, 0.18)',
};

const DEFAULT_DARK_ANSI: AnsiChromaticPalette = {
  red: '#f1716b',
  green: '#6cc98a',
  yellow: '#e8bf6a',
  blue: '#64a2f4',
  magenta: '#c988e8',
  cyan: '#5bc4d4',
  brightRed: '#ff8b85',
  brightGreen: '#85dca0',
  brightYellow: '#f5d384',
  brightBlue: '#82b8ff',
  brightMagenta: '#dba0f5',
  brightCyan: '#7ad8e6',
};

const DEFAULT_LIGHT_ANSI: AnsiChromaticPalette = {
  red: '#c93b33',
  green: '#237841',
  yellow: '#9a6500',
  blue: '#1f5ec4',
  magenta: '#8a3ab0',
  cyan: '#0f7887',
  brightRed: '#dc4840',
  brightGreen: '#2a8f4e',
  brightYellow: '#b07600',
  brightBlue: '#2c6fe0',
  brightMagenta: '#a149c9',
  brightCyan: '#148fa0',
};

// Canonical terminal ANSI-16 palettes for community color schemes that define
// their own terminal colors; all other schemes use DEFAULT_DARK_ANSI / DEFAULT_LIGHT_ANSI.
const SCHEME_ANSI: Record<string, { dark: AnsiChromaticPalette; light: AnsiChromaticPalette }> = {
  dracula: {
    dark: {
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
    },
    light: {
      red: '#c83232',
      green: '#1d7d3f',
      yellow: '#8f6a00',
      blue: '#6d44b8',
      magenta: '#b52d7b',
      cyan: '#0c7c94',
      brightRed: '#dc3f3f',
      brightGreen: '#24944c',
      brightYellow: '#a67c00',
      brightBlue: '#7f52cf',
      brightMagenta: '#cc3a8e',
      brightCyan: '#1292ad',
    },
  },
  catppuccin: {
    dark: {
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      brightRed: '#f5a0b8',
      brightGreen: '#b8ebb4',
      brightYellow: '#fceac2',
      brightBlue: '#9fc2fc',
      brightMagenta: '#f8d3ee',
      brightCyan: '#aae8de',
    },
    light: {
      red: '#d20f39',
      green: '#40a02b',
      yellow: '#c47a12',
      blue: '#1e66f5',
      magenta: '#8839ef',
      cyan: '#179299',
      brightRed: '#e0244d',
      brightGreen: '#4ab334',
      brightYellow: '#d68818',
      brightBlue: '#3577fa',
      brightMagenta: '#9b52f5',
      brightCyan: '#1ca5ad',
    },
  },
  nord: {
    dark: {
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      brightRed: '#d0727c',
      brightGreen: '#b5cf9f',
      brightYellow: '#f2d79e',
      brightBlue: '#93b4d4',
      brightMagenta: '#c49ebd',
      brightCyan: '#8fbcbb',
    },
    light: {
      red: '#a83b46',
      green: '#46733b',
      yellow: '#946916',
      blue: '#3b6491',
      magenta: '#7c5178',
      cyan: '#267285',
      brightRed: '#bf4652',
      brightGreen: '#538747',
      brightYellow: '#ad7c1c',
      brightBlue: '#4776ab',
      brightMagenta: '#91618c',
      brightCyan: '#2f879c',
    },
  },
  solarized: {
    dark: {
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      brightRed: '#cb4b16',
      brightGreen: '#9cb014',
      brightYellow: '#cca014',
      brightBlue: '#47a3e6',
      brightMagenta: '#6c71c4',
      brightCyan: '#3dbab0',
    },
    light: {
      red: '#dc322f',
      green: '#6c7d00',
      yellow: '#9c7300',
      blue: '#268bd2',
      magenta: '#c42b74',
      cyan: '#1f877f',
      brightRed: '#cb4b16',
      brightGreen: '#7d9100',
      brightYellow: '#b58900',
      brightBlue: '#1b75b8',
      brightMagenta: '#6c71c4',
      brightCyan: '#2aa198',
    },
  },
};

function pick(readVar: CssVarReader, name: string, fallback: string): string {
  const value = readVar(name).trim();
  return value || fallback;
}

/**
 * Converts a hex or rgb()/rgba() color to an `rgba(r, g, b, alpha)` string that
 * xterm.js can parse directly (unlike CSS `color-mix(...)`, which xterm ignores).
 */
function withAlpha(color: string, alpha: number, fallback: string): string {
  const trimmed = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(trimmed);
  if (hex) {
    const digits = hex[1]!;
    const r =
      digits.length === 3
        ? Number.parseInt(digits[0]! + digits[0]!, 16)
        : Number.parseInt(digits.slice(0, 2), 16);
    const g =
      digits.length === 3
        ? Number.parseInt(digits[1]! + digits[1]!, 16)
        : Number.parseInt(digits.slice(2, 4), 16);
    const b =
      digits.length === 3
        ? Number.parseInt(digits[2]! + digits[2]!, 16)
        : Number.parseInt(digits.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)$/i.exec(trimmed);
  if (rgb) {
    return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  }
  return fallback;
}

export function buildTerminalTheme(
  readVar: CssVarReader,
  isLight: boolean,
  colorScheme = 'peach',
): TerminalTheme {
  const fb = isLight ? LIGHT_CHROME_FALLBACKS : DARK_CHROME_FALLBACKS;
  const schemeAnsi = SCHEME_ANSI[colorScheme];
  const ansi = schemeAnsi
    ? isLight
      ? schemeAnsi.light
      : schemeAnsi.dark
    : isLight
      ? DEFAULT_LIGHT_ANSI
      : DEFAULT_DARK_ANSI;

  const background = pick(readVar, '--bg-base', fb.bgBase);
  const foreground = pick(readVar, '--text-primary', fb.textPrimary);
  const cursor = pick(readVar, '--accent-primary', fb.accentPrimary);
  const selectionBackground = withAlpha(cursor, isLight ? 0.35 : 0.32, fb.selection);
  const selectionInactiveBackground = withAlpha(
    cursor,
    isLight ? 0.18 : 0.16,
    fb.selectionInactive,
  );

  return {
    background,
    foreground,
    cursor,
    cursorAccent: background,
    selectionBackground,
    selectionInactiveBackground,
    black: isLight ? foreground : pick(readVar, '--bg-raised', fb.bgRaised),
    white: pick(readVar, '--text-secondary', fb.textSecondary),
    brightBlack: pick(readVar, '--text-faint', fb.textFaint),
    brightWhite: foreground,
    ...ansi,
  };
}

export function readDocumentTerminalTheme(): { theme: TerminalTheme; fontFamily: string } {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return {
      theme: buildTerminalTheme(() => '', false),
      fontFamily: "ui-monospace, Menlo, Consolas, 'Courier New', monospace",
    };
  }
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  const readVar: CssVarReader = (name) => styles.getPropertyValue(name);
  const isLight = root.getAttribute('data-theme') === 'light';
  const colorScheme = root.getAttribute('data-color-scheme') ?? 'peach';
  const fontFamily =
    readVar('--font-mono').trim() || "ui-monospace, Menlo, Consolas, 'Courier New', monospace";
  return {
    theme: buildTerminalTheme(readVar, isLight, colorScheme),
    fontFamily,
  };
}
