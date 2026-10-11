import { applyAppearance } from '../shared/appearance.ts';

declare global {
  interface Window {
    __FTPEACH_APPEARANCE__?: { light: boolean; colorScheme: string };
  }
}

/** Rust supplies a snapshot before scripts start, then updates it for live previews. */
export function installConfirmationAppearance(): () => void {
  const apply = () => {
    const appearance = window.__FTPEACH_APPEARANCE__;
    if (appearance) applyAppearance(appearance.light ? 'light' : 'dark', appearance.colorScheme);
  };
  window.addEventListener('ftpeach-appearance', apply);
  apply();
  return () => window.removeEventListener('ftpeach-appearance', apply);
}
