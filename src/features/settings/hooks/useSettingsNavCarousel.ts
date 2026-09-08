import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { SettingsNavLayout } from '../settingsNavLayout.ts';
import { calculateSettingsNavLayout, emptySettingsNavLayout } from '../settingsNavLayout.ts';

interface UseSettingsNavCarouselOptions {
  narrow: boolean;
  remeasureKey: unknown;
  activeIndex: number;
}

interface SettingsNavCarouselModel {
  settingsNavRef: RefObject<HTMLElement>;
  settingsNavWindowRef: RefObject<HTMLDivElement>;
  settingsNavTabsRef: RefObject<HTMLDivElement>;
  settingsNavCarousel: SettingsNavLayout;
  scrollSettingsTabs: (direction: -1 | 1) => void;
  revealSettingsTab: (index: number) => void;
}

export function useSettingsNavCarousel({
  narrow,
  remeasureKey,
  activeIndex,
}: UseSettingsNavCarouselOptions): SettingsNavCarouselModel {
  const settingsNavRef = useRef<HTMLElement>(null);
  const settingsNavWindowRef = useRef<HTMLDivElement>(null);
  const settingsNavTabsRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef(emptySettingsNavLayout);
  const [settingsNavCarousel, setSettingsNavCarousel] = useState(emptySettingsNavLayout);

  const update = useCallback((requestedStart = layoutRef.current.start, revealIndex?: number) => {
    const windowElement = settingsNavWindowRef.current;
    const tabs = settingsNavTabsRef.current;
    if (!windowElement || !tabs) return;
    const widths = Array.from(tabs.children, (tab) => tab.getBoundingClientRect().width);
    const next = calculateSettingsNavLayout(
      widths,
      windowElement.getBoundingClientRect().width,
      requestedStart,
      revealIndex,
    );
    const previous = layoutRef.current;
    if (
      Object.keys(next).every(
        (key) => next[key as keyof typeof next] === previous[key as keyof typeof next],
      )
    )
      return;
    layoutRef.current = next;
    setSettingsNavCarousel(next);
  }, []);

  useLayoutEffect(() => {
    if (!narrow) {
      layoutRef.current = emptySettingsNavLayout;
      setSettingsNavCarousel(emptySettingsNavLayout);
      return;
    }
    const viewport = settingsNavWindowRef.current;
    const tabs = settingsNavTabsRef.current;
    if (!viewport || !tabs) return;
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => update());
    observer.observe(viewport);
    observer.observe(tabs);
    Array.from(tabs.children).forEach((tab) => observer.observe(tab));
    return () => observer.disconnect();
  }, [narrow, remeasureKey, update]);

  useLayoutEffect(() => {
    if (narrow) update(layoutRef.current.start, activeIndex);
  }, [narrow, activeIndex, remeasureKey, update]);

  useLayoutEffect(() => {
    const nav = settingsNavRef.current;
    if (!narrow || !nav) return;
    let accumulated = 0;
    let lastEventTime = 0;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || !layoutRef.current.overflowing) return;
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      const rtl = getComputedStyle(nav).direction === 'rtl';
      const delta = horizontal ? event.deltaX * (rtl ? -1 : 1) : event.deltaY;
      if (!delta) return;
      // Own the gesture, including at the ends, without scrolling the dialog.
      event.preventDefault();
      const now = event.timeStamp;
      if (now - lastEventTime > 180 || Math.sign(delta) !== Math.sign(accumulated)) {
        accumulated = 0;
      }
      lastEventTime = now;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? nav.clientWidth : 1;
      accumulated += delta * unit;
      // Ignore touchpad jitter; a large wheel event still advances only one item.
      if (Math.abs(accumulated) < 40) return;
      update(layoutRef.current.start + Math.sign(accumulated));
      accumulated = 0;
    };
    nav.addEventListener('wheel', onWheel, { passive: false });
    return () => nav.removeEventListener('wheel', onWheel);
  }, [narrow, update]);

  const scrollSettingsTabs = (direction: -1 | 1) => {
    if (narrow) update(layoutRef.current.start + direction);
  };
  const revealSettingsTab = (index: number) => {
    if (narrow) update(layoutRef.current.start, index);
  };

  return {
    settingsNavRef,
    settingsNavWindowRef,
    settingsNavTabsRef,
    settingsNavCarousel,
    scrollSettingsTabs,
    revealSettingsTab,
  };
}
