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

const MODIFIER_NAMES = ['Ctrl', 'Alt', 'Shift'] as const;

const CODE_DISPLAY_LABELS = {
  Comma: ',',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
};

export type ShortcutKeyboardEvent = Pick<
  KeyboardEvent,
  'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
>;

function displayCode(code: string): string {
  if (code in CODE_DISPLAY_LABELS)
    return CODE_DISPLAY_LABELS[code as keyof typeof CODE_DISPLAY_LABELS];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

// Returns the canonical binding string for a keydown event, or `null` when
// the event is a bare modifier keypress (nothing to bind yet).
export function bindingFromEvent(event: ShortcutKeyboardEvent | null): string | null {
  if (!event || !event.code || MODIFIER_CODES.has(event.code)) return null;
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(event.code);
  return parts.join('+');
}

// Parses a canonical binding string into its parts, or `null` if malformed.
export interface ParsedBinding {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
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
    code,
  };
}

export function isValidBinding(binding: unknown): binding is string {
  return parseBinding(binding) !== null;
}

export function matchesBinding(event: ShortcutKeyboardEvent | null, binding: unknown): boolean {
  const parsed = parseBinding(binding);
  if (!parsed || !event) return false;
  return (
    event.code === parsed.code &&
    !!(event.ctrlKey || event.metaKey) === parsed.ctrl &&
    !!event.altKey === parsed.alt &&
    !!event.shiftKey === parsed.shift
  );
}

// Human-readable display form, e.g. "Ctrl+Shift+T". Returns '' for an
// invalid/empty binding — callers show their own "not assigned" placeholder.
export function formatBinding(binding: unknown): string {
  const parsed = parseBinding(binding);
  if (!parsed) return '';
  const parts: string[] = [];
  if (parsed.ctrl) parts.push('Ctrl');
  if (parsed.alt) parts.push('Alt');
  if (parsed.shift) parts.push('Shift');
  parts.push(displayCode(parsed.code));
  return parts.join('+');
}
