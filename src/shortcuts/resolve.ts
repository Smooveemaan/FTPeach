import { SHORTCUT_ACTIONS, shortcutActionsByScope } from './registry.ts';
import type { ShortcutAction, ShortcutScope } from './registry.ts';
import { matchesBinding } from './bindings.ts';
import type { ShortcutKeyboardEvent } from './bindings.ts';
import { hostPlatform } from '../platform/os.ts';

export type ShortcutOverrides = Record<string, string | undefined>;

export function actionDefault(action: ShortcutAction, platform = hostPlatform()): string {
  return platform === 'macos' && action.defaultMac ? action.defaultMac : action.default;
}

export function effectiveBinding(
  actionId: string,
  overrides?: ShortcutOverrides | null,
  platform = hostPlatform(),
): string | null {
  const entry = SHORTCUT_ACTIONS.find((action) => action.id === actionId);
  if (!entry) return null;
  const override = overrides ? overrides[actionId] : undefined;
  if (override === '') return null;
  if (typeof override === 'string') return override;
  return actionDefault(entry, platform);
}

// Map<actionId, binding> for every action in `scope`, honoring overrides.
// Unbound actions (override === '') are omitted.
function effectiveBindingsByScope(
  scope: ShortcutScope,
  overrides?: ShortcutOverrides | null,
  platform = hostPlatform(),
): Map<string, string> {
  const map = new Map<string, string>();
  for (const action of shortcutActionsByScope(scope)) {
    const binding = effectiveBinding(action.id, overrides, platform);
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
  platform = hostPlatform(),
): string | null {
  for (const [actionId, binding] of effectiveBindingsByScope(scope, overrides, platform)) {
    if (matchesBinding(event, binding, platform)) return actionId;
  }
  if (platform === 'macos') {
    for (const action of shortcutActionsByScope(scope)) {
      if (overrides && overrides[action.id] !== undefined) continue;
      if (action.aliasesMac) {
        for (const alias of action.aliasesMac) {
          if (matchesBinding(event, alias, platform)) return action.id;
        }
      }
    }
  }
  return null;
}

/**
 * Every other action bound to the same keys. Global shortcuts are caught
 * before a pane sees the key, so they collide with pane ones too.
 */
export function findConflicts(
  actionId: string,
  binding: string | null,
  overrides?: ShortcutOverrides | null,
  platform = hostPlatform(),
): string[] {
  if (!binding) return [];
  return [
    ...effectiveBindingsByScope('global', overrides, platform),
    ...effectiveBindingsByScope('pane', overrides, platform),
  ]
    .filter(([otherId, otherBinding]) => otherId !== actionId && otherBinding === binding)
    .map(([otherId]) => otherId);
}
