import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import TitleBar from '../../../src/app/TitleBar.tsx';
import * as windowControls from '../../../src/platform/useWindowControls.ts';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('TitleBar', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('on macOS: renders without custom window controls and has macos class', () => {
    const showSystemMenu = vi.fn();
    vi.spyOn(windowControls, 'useWindowControls').mockReturnValue({
      available: false,
      maximized: false,
      minimize: vi.fn(),
      toggleMaximize: vi.fn(),
      close: vi.fn(),
      showSystemMenu,
    });

    const { container } = render(<TitleBar minimizeToTray={false} platform="macos" />);
    const bar = container.querySelector('.title-bar');
    expect(bar).not.toBeNull();
    expect(bar?.classList.contains('macos')).toBe(true);
    expect(bar?.getAttribute('data-platform')).toBe('macos');
    expect(screen.queryByLabelText('titleBar.minimize')).toBeNull();
    expect(screen.queryByLabelText('titleBar.maximize')).toBeNull();
    expect(screen.queryByLabelText('common.close')).toBeNull();
    expect(container.querySelector('.title-bar-controls')).toBeNull();

    fireEvent.contextMenu(bar!);
    expect(showSystemMenu).not.toHaveBeenCalled();
  });

  test('on Windows: renders custom window controls when available and responds to context menu', () => {
    const showSystemMenu = vi.fn();
    const minimize = vi.fn();
    const toggleMaximize = vi.fn();
    const close = vi.fn();
    vi.spyOn(windowControls, 'useWindowControls').mockReturnValue({
      available: true,
      maximized: false,
      minimize,
      toggleMaximize,
      close,
      showSystemMenu,
    });

    const { container } = render(<TitleBar minimizeToTray={false} platform="windows" />);
    const bar = container.querySelector('.title-bar');
    expect(bar).not.toBeNull();
    expect(bar?.classList.contains('macos')).toBe(false);
    expect(bar?.getAttribute('data-platform')).toBe('windows');
    expect(container.querySelector('.title-bar-controls')).not.toBeNull();

    const minBtn = screen.getByLabelText('titleBar.minimize');
    fireEvent.click(minBtn);
    expect(minimize).toHaveBeenCalledOnce();

    const maxBtn = screen.getByLabelText('titleBar.maximize');
    fireEvent.click(maxBtn);
    expect(toggleMaximize).toHaveBeenCalledOnce();

    const closeBtn = screen.getByLabelText('common.close');
    fireEvent.click(closeBtn);
    expect(close).toHaveBeenCalledOnce();

    fireEvent.contextMenu(bar!);
    expect(showSystemMenu).toHaveBeenCalledOnce();
  });

  test('on Windows: hides custom window controls when not available (in browser)', () => {
    vi.spyOn(windowControls, 'useWindowControls').mockReturnValue({
      available: false,
      maximized: false,
      minimize: vi.fn(),
      toggleMaximize: vi.fn(),
      close: vi.fn(),
      showSystemMenu: vi.fn(),
    });

    const { container } = render(<TitleBar minimizeToTray={false} platform="windows" />);
    const bar = container.querySelector('.title-bar');
    expect(bar).not.toBeNull();
    expect(container.querySelector('.title-bar-controls')).toBeNull();
  });
});
