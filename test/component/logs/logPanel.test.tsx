import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, onTestFinished, test, vi } from 'vitest';
import LogPanel from '../../../src/features/logs/LogPanel.tsx';
import { flashTooltip } from '../../../src/hooks/useTooltip.ts';
import type { LogEntry } from '../../../src/shared/types.ts';
import { createLogTimeFormatter } from '../../../src/features/settings/dateFormat.ts';

vi.mock('../../../src/hooks/useTooltip.ts', () => ({ flashTooltip: vi.fn() }));

const formatTime = createLogTimeFormatter('iso', null);

const line = (seq: number, text: string, kind = 'status'): LogEntry => ({
  seq,
  line: text,
  kind,
  ts: 0,
  connectionId: 'c',
});

function renderPanel(lines: LogEntry[], { narrow = false } = {}) {
  return render(
    <LogPanel
      lines={lines}
      onClear={vi.fn()}
      narrow={narrow}
      showTimestamps={false}
      formatTime={formatTime}
    />,
  );
}

const shownLines = (container: HTMLElement) =>
  [...container.querySelectorAll('.log-chunk .log-line')].map((element) => element.textContent);

test('Copy flashes its tooltip on the button once the clipboard write settles', async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const { container } = renderPanel([line(1, 'hello')]);
  const copy = container.querySelector<HTMLButtonElement>(
    '[data-tooltip="logPanel.copyToClipboard"]',
  )!;
  await act(async () => {
    copy.click();
    await Promise.resolve();
  });
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('hello'));
  expect(flashTooltip).toHaveBeenCalledWith(copy, 'logPanel.copiedTooltip');
});

const copyButton = (container: HTMLElement) =>
  container.querySelector('[data-tooltip="logPanel.copyToClipboard"]');

test('search shows only the lines that contain the text, and Escape clears it', () => {
  const { container } = renderPanel([line(1, 'USER alice'), line(2, '331 Password required')]);
  const field = screen.getByRole('textbox', { name: 'logPanel.searchPlaceholder' });
  expect(container.querySelector('button[data-tooltip="logPanel.searchPlaceholder"]')).toBeNull();

  fireEvent.change(field, { target: { value: 'password' } });
  expect(shownLines(container)).toEqual(['331 Password required']);
  expect(copyButton(container)).not.toBeNull();

  fireEvent.keyDown(field, { key: 'Escape' });
  expect(screen.getByRole('textbox')).toBe(field);
  expect(shownLines(container)).toHaveLength(2);
});

test('narrow, search is a button whose field covers the other buttons until closed', () => {
  const { container } = renderPanel([line(1, 'USER alice'), line(2, '331 Password required')], {
    narrow: true,
  });
  const toggle = container.querySelector('button[data-tooltip="logPanel.searchPlaceholder"]')!;
  expect(screen.queryByRole('textbox')).toBeNull();

  fireEvent.click(toggle);
  const field = screen.getByRole('textbox', { name: 'logPanel.searchPlaceholder' });
  expect(document.activeElement).toBe(field);
  expect(copyButton(container)).toBeNull();
  fireEvent.change(field, { target: { value: 'password' } });
  expect(shownLines(container)).toEqual(['331 Password required']);

  fireEvent.click(toggle);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(copyButton(container)).not.toBeNull();
  expect(shownLines(container)).toHaveLength(2);

  fireEvent.click(toggle);
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
  expect(screen.queryByRole('textbox')).toBeNull();
});

test('the kind filter hides a type of line', () => {
  const { container } = renderPanel([
    line(1, 'USER alice', 'command'),
    line(2, '530 Login incorrect', 'error'),
  ]);
  fireEvent.click(container.querySelector('[data-tooltip="logPanel.filterKinds"]')!);
  fireEvent.click(screen.getByRole('menuitem', { name: /logPanel\.kindCommand/ }));
  expect(shownLines(container)).toEqual(['530 Login incorrect']);
});

test('pressing the filter button again closes its menu', () => {
  const { container } = renderPanel([line(1, 'USER alice', 'command')]);
  const button = container.querySelector('[data-tooltip="logPanel.filterKinds"]')!;
  fireEvent.click(button);
  expect(screen.queryByRole('menuitem', { name: /logPanel\.kindCommand/ })).not.toBeNull();
  fireEvent.mouseDown(button);
  fireEvent.click(button);
  expect(screen.queryByRole('menuitem', { name: /logPanel\.kindCommand/ })).toBeNull();
});

test('resizing slides the panel edge over the lines, and back puts them where they were', () => {
  const resizeCallbacks: Array<() => void> = [];
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  const { container } = renderPanel([line(1, 'hello')]);
  const body = container.querySelector<HTMLElement>('.log-panel-body')!;
  let clientHeight = 100;
  let scrollTop = 0;
  const scrollHeight = 1000;
  Object.defineProperties(body, {
    clientHeight: { get: () => clientHeight },
    scrollHeight: { get: () => scrollHeight },
    scrollTop: {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, scrollHeight - clientHeight));
      },
    },
  });
  const resizeTo = (height: number) => {
    clientHeight = height;
    scrollTop = Math.min(scrollTop, scrollHeight - clientHeight);
    resizeCallbacks.forEach((callback) => callback());
    fireEvent.scroll(body);
  };

  body.scrollTop = 400;
  fireEvent.scroll(body);
  resizeTo(50);
  expect(body.scrollTop).toBe(450);
  resizeTo(0);
  resizeTo(100);
  expect(body.scrollTop).toBe(400);

  body.scrollTop = 0;
  fireEvent.scroll(body);
  resizeTo(300);
  expect(body.scrollTop).toBe(0);
  resizeTo(100);
  expect(body.scrollTop).toBe(0);
});

test('lines render in blocks that keep their place across new lines', () => {
  const lines = Array.from({ length: 250 }, (_, index) => line(index + 1, `line ${index + 1}`));
  const { container, rerender } = renderPanel(lines);
  expect(container.querySelectorAll('.log-chunk')).toHaveLength(3);
  const firstBlock = container.querySelector('.log-chunk');
  rerender(
    <LogPanel
      lines={[...lines, line(251, 'line 251')]}
      onClear={vi.fn()}
      showTimestamps={false}
      formatTime={formatTime}
    />,
  );
  expect(container.querySelector('.log-chunk')).toBe(firstBlock);
  expect(shownLines(container).at(-1)).toBe('line 251');
});
