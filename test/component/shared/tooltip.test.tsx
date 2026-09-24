/* eslint no-unused-vars: ["warn", { "argsIgnorePattern": "^_|^this$" }] -- TypeScript receiver annotations are not runtime arguments. */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flashTooltip, useTooltip } from '../../../src/hooks/useTooltip.ts';

function Harness({ text = 'Help', below = false }: { text?: string; below?: boolean }) {
  useTooltip();
  return (
    <div data-tooltip-below={below ? '' : undefined}>
      <button data-tooltip={text}>
        <span>anchor</span>
      </button>
      <button>other</button>
    </div>
  );
}
const bubble = () => document.querySelector<HTMLDivElement>('.floating-tooltip')!;
const visible = () => bubble().classList.contains('visible');

beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.removeAttribute('data-keyboard-navigation');
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains('floating-tooltip')) return new DOMRect(0, 0, 100, 20);
    return new DOMRect(100, 100, 100, 30);
  });
});
afterEach(() => {
  vi.useRealTimers();
  document.documentElement.removeAttribute('data-keyboard-navigation');
});

test('hover waits, uses the latest pointer position and leaves without a delayed popup', () => {
  render(<Harness />);
  fireEvent.mouseOver(screen.getByText('anchor'), { clientX: 120 });
  act(() => vi.advanceTimersByTime(499));
  expect(visible()).toBe(false);
  fireEvent.mouseMove(document, { clientX: 170 });
  act(() => vi.advanceTimersByTime(1));
  expect(visible()).toBe(true);
  expect(bubble().textContent).toBe('Help');
  expect(bubble().style.left).toBe('120px');
  expect(bubble().style.top).toBe('72px');
  fireEvent.mouseOut(screen.getByText('anchor'), { relatedTarget: screen.getByText('other') });
  expect(visible()).toBe(false);
  fireEvent.mouseOver(screen.getByText('anchor'));
  fireEvent.mouseOut(screen.getByText('anchor'));
  act(() => vi.advanceTimersByTime(500));
  expect(visible()).toBe(false);
});

test('moving between children of an anchor neither dismisses nor restarts its tooltip', () => {
  render(<Harness />);
  const anchor = screen.getByText('anchor');
  fireEvent.mouseOver(anchor);
  act(() => vi.advanceTimersByTime(400));
  fireEvent.mouseOver(anchor.parentElement!);
  fireEvent.mouseOut(anchor.parentElement!, { relatedTarget: anchor });
  act(() => vi.advanceTimersByTime(100));
  expect(visible()).toBe(true);
});

test('mouse focus does not show a tooltip but keyboard focus does', () => {
  render(<Harness />);
  const anchor = screen.getByRole('button', { name: 'anchor' });
  // jsdom does not determine keyboard focus visibility from native input.
  vi.spyOn(anchor, 'matches').mockImplementation((selector) => selector === ':focus-visible');
  act(() => anchor.focus());
  act(() => vi.advanceTimersByTime(500));
  expect(visible()).toBe(false);
  document.documentElement.setAttribute('data-keyboard-navigation', '');
  fireEvent.focusIn(anchor);
  act(() => vi.advanceTimersByTime(500));
  expect(visible()).toBe(true);
  expect(bubble().style.left).toBe('100px');
  fireEvent.focusOut(anchor, { relatedTarget: screen.getByText('other') });
  expect(visible()).toBe(false);
});

test('returning focus from another window does not redisplay the same focused tooltip', () => {
  render(<Harness />);
  document.documentElement.setAttribute('data-keyboard-navigation', '');
  const anchor = screen.getByRole('button', { name: 'anchor' });
  vi.spyOn(anchor, 'matches').mockImplementation((selector) => selector === ':focus-visible');
  act(() => anchor.focus());
  act(() => vi.advanceTimersByTime(500));
  expect(visible()).toBe(true);
  fireEvent.blur(window);
  fireEvent.focusOut(anchor);
  fireEvent.focus(window);
  fireEvent.focusIn(anchor);
  act(() => vi.advanceTimersByTime(500));
  expect(visible()).toBe(false);
});

test('removed anchors and unmounted listeners cannot leave floating tooltips behind', async () => {
  const { unmount } = render(<Harness />);
  const anchor = screen.getByRole('button', { name: 'anchor' });
  fireEvent.mouseOver(anchor);
  act(() => vi.advanceTimersByTime(500));
  expect(visible()).toBe(true);
  await act(async () => anchor.remove());
  expect(visible()).toBe(false);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test('an empty tooltip does not display stale text from a previous anchor', () => {
  render(<Harness text="" />);
  fireEvent.mouseOver(screen.getByText('anchor'));
  act(() => vi.advanceTimersByTime(500));
  expect(visible()).toBe(false);
});

test('flash messages replace the previous timeout, expire and dismiss on pointer down', () => {
  render(<Harness />);
  const anchor = screen.getByRole('button', { name: 'anchor' });
  act(() => flashTooltip(anchor, 'Copied', 100));
  expect(visible()).toBe(true);
  expect(bubble().style.top).toBe('138px');
  act(() => vi.advanceTimersByTime(50));
  act(() => flashTooltip(anchor, 'Copied again', 200));
  act(() => vi.advanceTimersByTime(100));
  expect(visible()).toBe(true);
  expect(bubble().textContent).toBe('Copied again');
  act(() => vi.advanceTimersByTime(100));
  expect(visible()).toBe(false);
  act(() => flashTooltip(anchor, 'Copied'));
  fireEvent.mouseDown(document);
  expect(visible()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test('hovering after a flash cannot be hidden by the old flash timeout', () => {
  render(<Harness />);
  const anchor = screen.getByRole('button', { name: 'anchor' });
  act(() => flashTooltip(anchor, 'Copied', 800));
  fireEvent.mouseOver(anchor);
  act(() => vi.advanceTimersByTime(500));
  expect(bubble().textContent).toBe('Help');
  act(() => vi.advanceTimersByTime(500));
  expect(visible()).toBe(true);
});

test.each([false, true])(
  'position flips away from the viewport edge (prefer below: %s)',
  (below) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('floating-tooltip')) return new DOMRect(0, 0, 100, 20);
      return new DOMRect(0, below ? window.innerHeight - 30 : 0, 20, 20);
    });
    render(<Harness below={below} />);
    fireEvent.mouseOver(screen.getByText('anchor'), { clientX: 0 });
    act(() => vi.advanceTimersByTime(500));
    expect(bubble().style.left).toBe('8px');
    expect(Number.parseFloat(bubble().style.top)).toBe(below ? window.innerHeight - 58 : 28);
  },
);

test.each([600, 1200])(
  'long text chooses a bounded two-line width or clamps overflow (%s px)',
  (naturalWidth) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (!this.classList.contains('floating-tooltip')) return new DOMRect(100, 100, 100, 30);
      const width =
        this.style.whiteSpace === 'nowrap'
          ? naturalWidth
          : Number.parseFloat(this.style.width) || naturalWidth;
      return new DOMRect(0, 0, width, Math.ceil(naturalWidth / width) * 20);
    });
    render(<Harness />);
    bubble().style.padding = '0px';
    bubble().style.border = '0px solid';
    fireEvent.mouseOver(screen.getByText('anchor'));
    act(() => vi.advanceTimersByTime(500));
    expect(bubble().style.width).toBe(naturalWidth === 600 ? '300px' : '400px');
    expect(visible()).toBe(true);
  },
);
