import { SHORTCUT_ACTIONS, shortcutActionsByScope } from './registry.ts';
import type { ShortcutScope } from './registry.ts';
import { matchesBinding } from './bindings.ts';
import type { ShortcutKeyboardEvent } from './bindings.ts';

export type ShortcutOverrides = Record<string, string | undefined>;

export function effectiveBinding(
  actionId: string,
  overrides?: ShortcutOverrides | null,
): string | null {
  const entry = SHORTCUT_ACTIONS.find((action) => action.id === actionId);
  if (!entry) return null;
  const override = overrides ? overrides[actionId] : undefined;
  if (override === '') return null;
  if (typeof override === 'string') return override;
  return entry.default;
}

// Map<actionId, binding> for every action in `scope`, honoring overrides.
// Unbound actions (override === '') are omitted.
export function effectiveBindingsByScope(
  scope: ShortcutScope,
  overrides?: ShortcutOverrides | null,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const action of shortcutActionsByScope(scope)) {
    const binding = effectiveBinding(action.id, overrides);
    if (binding) map.set(action.id, binding);
  }
  return map;
}

// Resolves a keydown event to an action id within `scope`, or `null`.
// First match in registry order wins.
export function resolveAction(
  event: ShortcutKeyboardEvent,
  scope: ShortcutScope,
  overrides?: ShortcutOverrides | null,
): string | null {
  for (const [actionId, binding] of effectiveBindingsByScope(scope, overrides)) {
    if (matchesBinding(event, binding)) return actionId;
  }
  return null;
}

export function findConflict(
  actionId: string,
  binding: string | null,
  scope: ShortcutScope,
  overrides?: ShortcutOverrides | null,
): string | null {
  if (!binding) return null;
  for (const [otherId, otherBinding] of effectiveBindingsByScope(scope, overrides)) {
    if (otherId !== actionId && otherBinding === binding) return otherId;
  }
  return null;
}
