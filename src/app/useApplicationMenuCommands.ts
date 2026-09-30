import type { MenuBarEntry } from '../components/MenuBar.tsx';
import { api } from '../platform/api/index.ts';
import type { ApplicationCommandContext } from './menus.ts';
import { applicationShortcuts, buildMenus } from './menus.ts';
import { useAppCommands } from './useAppCommands.ts';

/**
 * Registers the global shortcuts and builds the menu bar from one context, so
 * the two ways of running an application command cannot drift apart.
 */
export function useApplicationMenuCommands(context: ApplicationCommandContext): MenuBarEntry[] {
  useAppCommands(
    {
      modalOpen: context.modalOpen,
      openDevtools: () => api.app.openDevtools(),
      ...applicationShortcuts(context),
    },
    context.settings.shortcuts.keyboardShortcuts,
  );
  return buildMenus(context);
}
