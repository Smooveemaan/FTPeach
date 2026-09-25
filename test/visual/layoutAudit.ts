/**
 * Finds text the layout lets down, in whatever is on screen: text cut off by
 * its container or the window, text spilling out of or wrapping inside a
 * control, text drawn over other text, a sideways scrollbar, a raw i18n key,
 * and (in the pseudo-locale) text that never went through i18next.
 *
 * Runs inside the page through `page.evaluate`, so it must stay
 * self-contained: no imports, no helpers from outside the function.
 */
export interface LayoutProblem {
  kind:
    | 'clipped'
    | 'truncated'
    | 'spills'
    | 'wraps'
    | 'overlap'
    | 'hscroll'
    | 'tooltip-clamped'
    | 'raw-key'
    | 'untranslated';
  /** A stable CSS path to the element, for grouping one problem across languages. */
  where: string;
  text: string;
  detail: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface LayoutAuditOptions {
  keys: string[];
  pseudo: { open: string; close: string } | null;
  /** Regular expressions for text that is fixture data rather than interface. */
  data: string[];
}

export function auditLayout({ keys, pseudo, data }: LayoutAuditOptions): LayoutProblem[] {
  const problems: LayoutProblem[] = [];
  const keySet = new Set(keys);
  const dataPatterns = data.map((source) => new RegExp(source));
  const isDataText = (text: string) => dataPatterns.some((pattern) => pattern.test(text));
  const TOLERANCE = 1;
  const CONTROL =
    'button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="tab"], [role="option"], .btn, .segmented-control label';
  const LAYER =
    '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .menu-dropdown, .context-menu, .tooltip';
  const view = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  type Box = { left: number; top: number; right: number; bottom: number };

  const pathOf = (element: Element): string => {
    const parts: string[] = [];
    for (let node: Element | null = element; node && node !== document.body;) {
      const classes = Array.from(node.classList)
        .filter((name) => !/^(active|selected|focused|open|hover|is-|state-)/.test(name))
        .slice(0, 2);
      parts.unshift(node.tagName.toLowerCase() + classes.map((name) => `.${name}`).join(''));
      if (parts.length >= 4) break;
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const rectOf = (box: Box) => ({
    x: Math.round(box.left),
    y: Math.round(box.top),
    width: Math.round(box.right - box.left),
    height: Math.round(box.bottom - box.top),
  });
  const intersect = (a: Box, b: Box): Box => ({
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  });
  const hidden = (element: Element): boolean => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return true;
      }
      if (node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true') return true;
    }
    const box = element.getBoundingClientRect();
    return box.width <= 1 || box.height <= 1;
  };
  /** Where `element` may draw before its text counts as cut (`box`), what of it
   * actually shows (`paint`), and whether an ellipsis or fade marks the cut. */
  const clipOf = (element: Element): { box: Box; paint: Box; marked: boolean } => {
    let box: Box = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
    let paint: Box = { ...view };
    let marked = false;
    // Past a scroll container the text is reached by scrolling, not cut off.
    let scrolledX = false;
    let scrolledY = false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      const scrolls = (value: string) => value === 'auto' || value === 'scroll';
      // Column headers clip, but code scrolls them sideways in step with their list.
      const synced = node.matches('.row-header, .transfer-col-header');
      const clipsX =
        !scrolledX && !synced && style.overflowX !== 'visible' && !scrolls(style.overflowX);
      const clipsY = !scrolledY && style.overflowY !== 'visible' && !scrolls(style.overflowY);
      scrolledX ||= synced || scrolls(style.overflowX);
      scrolledY ||= scrolls(style.overflowY);
      const outer = node.getBoundingClientRect();
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
        paint = intersect(paint, {
          left: style.overflowX === 'visible' ? -Infinity : outer.left + node.clientLeft,
          right:
            style.overflowX === 'visible'
              ? Infinity
              : outer.left + node.clientLeft + node.clientWidth,
          top: style.overflowY === 'visible' ? -Infinity : outer.top + node.clientTop,
          bottom:
            style.overflowY === 'visible'
              ? Infinity
              : outer.top + node.clientTop + node.clientHeight,
        });
      }
      if (!clipsX && !clipsY) continue;
      const inner = {
        left: clipsX ? outer.left + node.clientLeft : -Infinity,
        right: clipsX ? outer.left + node.clientLeft + node.clientWidth : Infinity,
        top: clipsY ? outer.top + node.clientTop : -Infinity,
        bottom: clipsY ? outer.top + node.clientTop + node.clientHeight : Infinity,
      };
      box = intersect(box, inner);
      if (
        style.textOverflow === 'ellipsis' ||
        style.maskImage !== 'none' ||
        node.classList.contains('truncated')
      ) {
        marked = true;
      }
    }
    // The window edge cuts only what no scrolling can bring into view.
    box = intersect(box, {
      left: scrolledX ? -Infinity : view.left,
      right: scrolledX ? Infinity : view.right,
      top: scrolledY ? -Infinity : view.top,
      bottom: scrolledY ? Infinity : view.bottom,
    });
    return { box, paint, marked };
  };

  interface TextBox {
    element: HTMLElement;
    text: string;
    visible: Box;
  }
  const texts: TextBox[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim() ?? '';
    const element = node.parentElement;
    if (!text || !element || element.closest('script, style, .select-menu-sizer')) continue;
    if (/-measure\b|sizer/.test(element.className.toString()) || hidden(element)) continue;
    range.selectNodeContents(node);
    const full = range.getBoundingClientRect();
    if (full.width === 0 || full.height === 0) continue;
    const where = pathOf(element);
    const { box: clip, paint, marked } = clipOf(element);
    const visible = intersect(full, paint);
    // A glyph box is taller than a tight line box; only a lost part of a line counts.
    const lineHeight = range.getClientRects()[0]?.height ?? full.height;
    const cutX = Math.max(clip.left - full.left, full.right - clip.right);
    const cutY = Math.max(clip.top - full.top, full.bottom - clip.bottom);
    const cut = Math.max(cutX, cutY > lineHeight * 0.3 ? cutY : 0);
    if (visible.right - visible.left <= 0 || visible.bottom - visible.top <= 0) continue;
    // Fixture data (file names, hosts) is cut by design and says nothing about a language.
    const isData = isDataText(text);
    if (cut > TOLERANCE && !isData) {
      problems.push({
        kind: marked ? 'truncated' : 'clipped',
        where,
        text,
        detail: `${Math.round(cut)}px cut off`,
        rect: rectOf(full),
      });
    }
    const control = element.closest<HTMLElement>(CONTROL);
    if (control && !isData) {
      const own = control.getBoundingClientRect();
      const spill = Math.max(own.left - full.left, full.right - own.right);
      if (spill > TOLERANCE && cut <= TOLERANCE) {
        problems.push({
          kind: 'spills',
          where,
          text,
          detail: `${Math.round(spill)}px outside the control`,
          rect: rectOf(full),
        });
      }
      const lines = new Set(Array.from(range.getClientRects(), (line) => Math.round(line.top)));
      if (lines.size > 1) {
        problems.push({
          kind: 'wraps',
          where,
          text,
          detail: `${lines.size} lines`,
          rect: rectOf(full),
        });
      }
    }
    if (keySet.has(text)) {
      problems.push({
        kind: 'raw-key',
        where,
        text,
        detail: 'i18n key shown as text',
        rect: rectOf(full),
      });
    } else if (
      pseudo &&
      /\p{L}/u.test(text) &&
      !text.includes(pseudo.open) &&
      !text.includes(pseudo.close) &&
      !isData
    ) {
      problems.push({
        kind: 'untranslated',
        where,
        text,
        detail: 'not from a translation',
        rect: rectOf(full),
      });
    }
    texts.push({ element, text, visible });
  }

  // Covered by a menu or dialog is fine; drawn over another text in the same layer is not.
  const layerOf = (element: Element) => element.closest(LAYER);
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i]!;
      const b = texts[j]!;
      if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
      if (layerOf(a.element) !== layerOf(b.element)) continue;
      const both = intersect(a.visible, b.visible);
      if (both.right - both.left > 2 && both.bottom - both.top > 2) {
        problems.push({
          kind: 'overlap',
          where: pathOf(a.element),
          text: `${a.text} ⟷ ${b.text}`,
          detail: `with ${pathOf(b.element)}`,
          rect: rectOf(both),
        });
      }
    }
  }

  for (const element of document.querySelectorAll<HTMLElement>('body *')) {
    const style = getComputedStyle(element);
    if (style.overflowX !== 'auto' && style.overflowX !== 'scroll') continue;
    // File and transfer lists scroll sideways by design.
    if (element.matches('.pane-list, .transfer-list')) continue;
    if (element.scrollWidth - element.clientWidth <= TOLERANCE || hidden(element)) continue;
    problems.push({
      kind: 'hscroll',
      where: pathOf(element),
      text: '',
      detail: `${element.scrollWidth - element.clientWidth}px wider than its box`,
      rect: rectOf(element.getBoundingClientRect()),
    });
  }

  // A tooltip gets at most 400px (less in a narrow window), then the CSS line clamp.
  const probe = document.createElement('div');
  probe.className = 'floating-tooltip';
  probe.style.width = `${Math.min(400, window.innerWidth - 16)}px`;
  document.body.append(probe);
  const tooltips = new Map<string, HTMLElement>();
  for (const element of document.querySelectorAll<HTMLElement>('[data-tooltip]')) {
    const value = element.dataset.tooltip?.trim();
    if (!value || tooltips.has(value) || isDataText(value) || hidden(element)) continue;
    tooltips.set(value, element);
  }
  for (const [value, element] of tooltips) {
    probe.textContent = value;
    const lost = probe.scrollHeight - probe.clientHeight;
    if (lost > TOLERANCE) {
      problems.push({
        kind: 'tooltip-clamped',
        where: pathOf(element),
        text: value,
        detail: `${Math.round(lost)}px past the line clamp`,
        rect: rectOf(element.getBoundingClientRect()),
      });
    }
  }
  probe.remove();

  if (pseudo) {
    for (const element of document.querySelectorAll<HTMLElement>(
      '[aria-label], [title], [placeholder], [data-tooltip]',
    )) {
      if (hidden(element)) continue;
      for (const name of ['aria-label', 'title', 'placeholder', 'data-tooltip']) {
        const value = element.getAttribute(name)?.trim();
        if (!value || !/\p{L}/u.test(value) || value.includes(pseudo.open)) continue;
        if (isDataText(value)) continue;
        problems.push({
          kind: keySet.has(value) ? 'raw-key' : 'untranslated',
          where: pathOf(element),
          text: value,
          detail: `${name} not from a translation`,
          rect: rectOf(element.getBoundingClientRect()),
        });
      }
    }
  }
  return problems;
}
