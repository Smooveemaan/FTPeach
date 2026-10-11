/** Focus a menu row without letting the browser recenter its scroll container. */
export function focusMenuItem(item: HTMLButtonElement | null | undefined): void {
  if (!item) return;
  item.focus({ preventScroll: true });
  for (let parent = item.parentElement; parent; parent = parent.parentElement) {
    if (
      parent.scrollHeight > parent.clientHeight &&
      /auto|scroll/.test(getComputedStyle(parent).overflowY)
    ) {
      const row = item.getBoundingClientRect();
      const viewport = parent.getBoundingClientRect();
      const top = viewport.top + parent.clientTop;
      const bottom = top + parent.clientHeight;
      if (row.top < top) parent.scrollTop += row.top - top;
      else if (row.bottom > bottom) parent.scrollTop += row.bottom - bottom;
      break;
    }
    if (parent.classList.contains('menu-dropdown') || parent.classList.contains('context-menu'))
      break;
  }
}
