import type { MenuBarEntry } from '../components/MenuBar.tsx';
import type { MenusContext } from './menus.ts';
import { buildMenus } from './menus.ts';
import {
  useApplicationCommandBindings,
  type ApplicationCommandBindings,
} from './useApplicationController.ts';

interface ApplicationMenuCommandsOptions {
  commands: ApplicationCommandBindings;
  menu: MenusContext;
}

/**
 * Owns the application-level command surface. Keeping keyboard commands and
 * menu entries together makes it harder for the two interaction paths to
 * drift while Application remains responsible only for dependency wiring.
 */
export function useApplicationMenuCommands({
  commands,
  menu,
}: ApplicationMenuCommandsOptions): MenuBarEntry[] {
  useApplicationCommandBindings(commands);
  return buildMenus(menu);
}
