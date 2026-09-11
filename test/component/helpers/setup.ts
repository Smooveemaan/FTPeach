/* global HTMLCanvasElement, HTMLElement, window */
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: vi.fn(),
});

// jsdom has no layout engine; match its zero-sized element geometry for ranges.
Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => new DOMRect(),
});

// Without the native `canvas` package jsdom has no 2D context: getContext()
// returns null and reports "Not implemented" on the console, once per call.
// The text-measuring callers already fall back without a context, so return
// the same null without the report.
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => null,
});

Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: { ...globalThis.crypto, randomUUID: vi.fn(() => 'test-uuid') },
});
