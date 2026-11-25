import { useEffect, useRef } from 'react';
import type { MenuBarEntry } from '../components/MenuBar.tsx';
import { api } from '../platform/api/index.ts';
import { hostPlatform } from '../platform/os.ts';
import { stepFileListScale, stepTerminalFontSize } from '../shared/contentZoom.ts';
import type { ApplicationCommandContext, ZoomTarget } from './menus.ts';
import { applicationShortcuts, buildMenus, resolveZoomTarget } from './menus.ts';
import { useAppCommands } from './useAppCommands.ts';
import { useNativeAppMenu } from './useNativeAppMenu.ts';

/**
 * Registers the global shortcuts and builds the menu bar from one context, so
 * the two ways of running an application command cannot drift apart.
 */
export function useApplicationMenuCommands(context: ApplicationCommandContext): MenuBarEntry[] {
  const lastFocusTargetRef = useRef<ZoomTarget>('fileList');
  const modalOpenRef = useRef(context.modalOpen);
  modalOpenRef.current = context.modalOpen;
  const setFileListScaleRef = useRef(context.applicationSettings.setFileListScale);
  setFileListScaleRef.current = context.applicationSettings.setFileListScale;
  const setTerminalFontSizeRef = useRef(context.applicationSettings.setTerminalFontSize);
  setTerminalFontSizeRef.current = context.applicationSettings.setTerminalFontSize;

  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('.menu-bar, .menu-dropdown')) return;
      lastFocusTargetRef.current = event.target.closest(
        '.terminal-panel, [data-terminal-input="true"]',
      )
        ? 'terminal'
        : 'fileList';
    };
    document.addEventListener('focusin', onFocusIn, true);
    return () => document.removeEventListener('focusin', onFocusIn, true);
  }, []);

  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      const zoomModifier =
        hostPlatform() === 'macos'
          ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
          : event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      if (!zoomModifier) return;
      event.preventDefault();
      if (modalOpenRef.current || event.deltaY === 0) return;
      if (!(event.target instanceof Element)) return;
      const direction: 1 | -1 = event.deltaY < 0 ? 1 : -1;
      if (event.target.closest('.terminal-panel:not(.is-collapsed)')) {
        setTerminalFontSizeRef.current((current) => stepTerminalFontSize(current, direction));
      } else if (event.target.closest('.pane-list')) {
        setFileListScaleRef.current((current) => stepFileListScale(current, direction));
      }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);

  const contextWithZoom: ApplicationCommandContext = {
    ...context,
    getZoomTarget: context.getZoomTarget ?? (() => resolveZoomTarget(lastFocusTargetRef.current)),
  };

  useAppCommands(
    {
      modalOpen: context.modalOpen,
      openDevtools: () => api.app.openDevtools(),
      ...applicationShortcuts(contextWithZoom),
    },
    context.settings.shortcuts.keyboardShortcuts,
  );
  const menus = buildMenus(contextWithZoom);
  useNativeAppMenu(menus, () => context.dialogs.setShowAbout(true));
  return menus;
}
