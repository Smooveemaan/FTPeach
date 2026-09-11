import { useEffect } from 'react';

const EDGE_MARGIN = 8;
const GAP = 8;
const SHOW_DELAY = 500;
const FLASH_DURATION = 2200;
const MAX_TOOLTIP_WIDTH = 400;

let tooltipEl: HTMLDivElement | null = null;
function ensureTooltipEl(): HTMLDivElement {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'floating-tooltip';
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}

function fitWidth(el: HTMLElement) {
  const cs = getComputedStyle(el);
  // Constant across every candidate width, so subtracting it out turns
  // "rendered height" into "line count" without hardcoding padding/border.
  const base =
    parseFloat(cs.paddingTop) +
    parseFloat(cs.paddingBottom) +
    parseFloat(cs.borderTopWidth) +
    parseFloat(cs.borderBottomWidth);

  // Measured from the window's edge: left where the last tooltip stood, near
  // the right edge of a narrow window, an auto width would wrap to the little
  // room left there, even for text that fits the window on one line.
  el.style.left = '0px';
  el.style.top = '0px';
  el.style.display = 'block';
  el.style.webkitLineClamp = 'unset';
  el.style.width = '';
  el.style.whiteSpace = 'nowrap';
  const naturalWidth = el.getBoundingClientRect().width;
  const lineHeight = el.getBoundingClientRect().height - base;
  el.style.whiteSpace = 'normal';

  const cap = Math.min(MAX_TOOLTIP_WIDTH, window.innerWidth - EDGE_MARGIN * 2);
  const linesAt = (w: number) => {
    el.style.width = `${w}px`;
    return Math.round((el.getBoundingClientRect().height - base) / lineHeight);
  };

  if (naturalWidth <= cap) {
    // Pinned, so moving it into place cannot rewrap it either.
    el.style.width = `${Math.ceil(naturalWidth)}px`;
  } else if (linesAt(cap) > 2) {
    // Even the cap can't fit two lines; leave it there and let the CSS
    // line-clamp ellipsize the overflow.
    el.style.width = `${cap}px`;
  } else {
    let lo = 1;
    let hi = Math.ceil(cap);
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (linesAt(mid) <= 2) hi = mid;
      else lo = mid + 1;
    }
    el.style.width = `${hi}px`;
  }

  el.style.display = '';
  el.style.webkitLineClamp = '';
}

function position(
  anchor: HTMLElement,
  text: string,
  preferBelow = false,
  cursorX: number | null = null,
) {
  const el = ensureTooltipEl();
  el.textContent = text;
  fitWidth(el);
  const rect = anchor.getBoundingClientRect();
  const vgroup = anchor.closest('[data-tooltip-vgroup]');
  const vrect = vgroup ? vgroup.getBoundingClientRect() : rect;
  const bubble = el.getBoundingClientRect();
  let top;
  if (preferBelow) {
    top = vrect.bottom + GAP;
    if (top + bubble.height > window.innerHeight - EDGE_MARGIN)
      top = vrect.top - GAP - bubble.height;
  } else {
    top = vrect.top - GAP - bubble.height;
    if (top < EDGE_MARGIN) top = vrect.bottom + GAP;
  }
  const centerX =
    cursorX == null
      ? rect.left + rect.width / 2
      : Math.min(Math.max(cursorX, rect.left), rect.right);
  let left = centerX - bubble.width / 2;
  left = Math.min(Math.max(left, EDGE_MARGIN), window.innerWidth - bubble.width - EDGE_MARGIN);
  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
}

let hideTimer: ReturnType<typeof setTimeout> | null = null;
let dismissCleanup: (() => void) | null = null;
function hideNow() {
  if (hideTimer != null) clearTimeout(hideTimer);
  hideTimer = null;
  if (dismissCleanup) {
    dismissCleanup();
    dismissCleanup = null;
  }
  if (tooltipEl) tooltipEl.classList.remove('visible');
}

export function resetTooltipStateForTests(): void {
  if (hideTimer != null) clearTimeout(hideTimer);
  hideTimer = null;
  dismissCleanup = null;
  tooltipEl?.remove();
  tooltipEl = null;
}

export function flashTooltip(anchorEl: HTMLElement, text: string, duration = FLASH_DURATION) {
  if (hideTimer != null) clearTimeout(hideTimer);
  if (dismissCleanup) {
    dismissCleanup();
    dismissCleanup = null;
  }
  position(anchorEl, text, true);
  ensureTooltipEl().classList.add('visible');
  hideTimer = setTimeout(hideNow, duration);

  const onPointerDown = () => hideNow();
  document.addEventListener('mousedown', onPointerDown, true);
  dismissCleanup = () => document.removeEventListener('mousedown', onPointerDown, true);
}

export function useTooltip(): void {
  useEffect(() => {
    ensureTooltipEl();
    let showTimer: ReturnType<typeof setTimeout> | null = null;
    let current: HTMLElement | null = null;
    // Only meaningful for mouse-driven hovers, not keyboard focus — reset to
    // null on focusin so a focused anchor falls back to dead-center.
    let hoverX: number | null = null;
    let blurredAnchor: HTMLElement | null = null;

    const hide = () => {
      if (showTimer != null) clearTimeout(showTimer);
      showTimer = null;
      current = null;
      hideNow();
    };

    const show = (event: MouseEvent | FocusEvent) => {
      const anchor =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-tooltip]')
          : null;
      if (!anchor) return;
      if (event.type === 'focusin' && anchor === blurredAnchor) {
        blurredAnchor = null;
        current = anchor;
        return;
      }
      blurredAnchor = null;
      if (
        event.type === 'focusin' &&
        (!document.documentElement.hasAttribute('data-keyboard-navigation') ||
          !anchor.matches(':focus-visible'))
      )
        return;
      if (anchor === current) return;
      hide();
      current = anchor;
      hoverX = event instanceof MouseEvent && event.type === 'mouseover' ? event.clientX : null;
      showTimer = setTimeout(() => {
        const text = anchor.getAttribute('data-tooltip');
        if (!text) return;
        if (hideTimer != null) clearTimeout(hideTimer); // don't let a pending flashTooltip() hide us right after we show
        position(anchor, text, !!anchor.closest('[data-tooltip-below]'), hoverX);
        ensureTooltipEl().classList.add('visible');
      }, SHOW_DELAY);
    };

    const move = (event: MouseEvent) => {
      if (current) hoverX = event.clientX;
    };

    const leave = (event: MouseEvent | FocusEvent) => {
      const anchor =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-tooltip]')
          : null;
      if (!anchor || anchor !== current) return;
      const related = event.relatedTarget;
      if (related instanceof Node && anchor.contains(related)) return;
      hide();
    };

    const onWindowBlur = () => {
      blurredAnchor = document.activeElement?.closest<HTMLElement>('[data-tooltip]') ?? null;
    };
    const onWindowFocus = () => {
      if (blurredAnchor && document.activeElement !== blurredAnchor) blurredAnchor = null;
    };

    document.addEventListener('mouseover', show);
    document.addEventListener('focusin', show);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseout', leave);
    document.addEventListener('focusout', leave);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('focus', onWindowFocus);

    const observer = new MutationObserver(() => {
      if (current && !current.isConnected) hide();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      document.removeEventListener('mouseover', show);
      document.removeEventListener('focusin', show);
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseout', leave);
      document.removeEventListener('focusout', leave);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('focus', onWindowFocus);
      observer.disconnect();
      hide();
    };
  }, []);
}
