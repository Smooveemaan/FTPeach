/* global HTMLElement, window */
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

Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: { ...globalThis.crypto, randomUUID: vi.fn(() => 'test-uuid') },
});
