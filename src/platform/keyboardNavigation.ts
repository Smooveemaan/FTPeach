// Browser focus-visible heuristics also react to Escape/Enter/Delete. Only
// explicit tab navigation should enable the application's keyboard focus cues.
export function installKeyboardNavigation() {
  const root = document.documentElement;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      root.setAttribute('data-keyboard-navigation', '');
    }
  };
  const onPointerDown = () => root.removeAttribute('data-keyboard-navigation');

  onPointerDown();
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('pointerdown', onPointerDown, true);
  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('pointerdown', onPointerDown, true);
    onPointerDown();
  };
}
