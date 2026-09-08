export function isTextInput(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement && (target.matches('input, textarea') || target.isContentEditable)
  );
}

export function isTextEditingShortcut(event: KeyboardEvent): boolean {
  return (
    isTextInput(event.target) &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    ['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY'].includes(event.code)
  );
}
