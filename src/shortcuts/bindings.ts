import { hostPlatform } from '../platform/os.ts';

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);

const MODIFIER_NAMES = ['Ctrl', 'Alt', 'Shift', 'Cmd'] as const;

const CODE_DISPLAY_LABELS: Record<string, string> = {
  Comma: ',',
  Period: '.',
  BracketLeft: '[',
  BracketRight: ']',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
};

export type ShortcutKeyboardEvent = Pick<
  KeyboardEvent,
  'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
>;

function displayCode(code: string, platform = hostPlatform()): string {
  if (platform === 'macos') {
    if (code === 'Enter') return 'Return';
    if (code === 'Backspace') return '⌫';
  }
  if (code in CODE_DISPLAY_LABELS) return CODE_DISPLAY_LABELS[code]!;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

// Returns the canonical binding string for a keydown event, or `null` when
// the event is a bare modifier keypress (nothing to bind yet).
export function bindingFromEvent(
  event: ShortcutKeyboardEvent | null,
  platform = hostPlatform(),
): string | null {
  if (!event || !event.code || MODIFIER_CODES.has(event.code)) return null;
  const parts: string[] = [];
  if (platform === 'macos') {
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Cmd');
  } else {
    if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
  }
  parts.push(event.code);
  return parts.join('+');
}

// Parses a canonical binding string into its parts, or `null` if malformed.
export interface ParsedBinding {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  cmd: boolean;
  code: string;
}

export function parseBinding(binding: unknown): ParsedBinding | null {
  if (typeof binding !== 'string' || !binding) return null;
  const parts = binding.split('+');
  const code = parts[parts.length - 1];
  if (
    !code ||
    MODIFIER_CODES.has(code) ||
    MODIFIER_NAMES.includes(code as (typeof MODIFIER_NAMES)[number])
  )
    return null;
  const mods = parts.slice(0, -1);
  if (mods.length !== new Set(mods).size) return null;
  if (mods.some((mod) => !MODIFIER_NAMES.includes(mod as (typeof MODIFIER_NAMES)[number])))
    return null;
  return {
    ctrl: mods.includes('Ctrl'),
    alt: mods.includes('Alt'),
    shift: mods.includes('Shift'),
    cmd: mods.includes('Cmd'),
    code,
  };
}

export function isValidBinding(binding: unknown): binding is string {
  return parseBinding(binding) !== null;
}

export function matchesBinding(
  event: ShortcutKeyboardEvent | null,
  binding: unknown,
  platform = hostPlatform(),
): boolean {
  const parsed = parseBinding(binding);
  if (!parsed || !event) return false;
  if (event.code !== parsed.code) return false;
  if (!!event.altKey !== parsed.alt) return false;
  if (!!event.shiftKey !== parsed.shift) return false;
  if (platform === 'macos') {
    return !!event.ctrlKey === parsed.ctrl && !!event.metaKey === parsed.cmd;
  }
  return !!(event.ctrlKey || event.metaKey) === (parsed.ctrl || parsed.cmd);
}

// Human-readable display form, e.g. "Ctrl+Shift+T" or "⇧⌘T" on macOS.
// Returns '' for an invalid/empty binding — callers show their own placeholder.
export function formatBinding(binding: unknown, platform = hostPlatform()): string {
  const parsed = parseBinding(binding);
  if (!parsed) return '';
  if (platform === 'macos') {
    let mods = '';
    if (parsed.ctrl) mods += '⌃';
    if (parsed.alt) mods += '⌥';
    if (parsed.shift) mods += '⇧';
    if (parsed.cmd) mods += '⌘';
    return `${mods}${displayCode(parsed.code, 'macos')}`;
  }
  const parts: string[] = [];
  if (parsed.ctrl || parsed.cmd) parts.push('Ctrl');
  if (parsed.alt) parts.push('Alt');
  if (parsed.shift) parts.push('Shift');
  parts.push(displayCode(parsed.code, platform));
  return parts.join('+');
}
