import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_COLUMN_ORDER,
  sanitizeColumnOrder,
} from '../../../src/features/transfers/transferColumns.ts';
import SETTINGS_DEFAULTS from '../../../src/shared/settingsDefaults.ts';

test('the saved default order is the order the list starts with', () => {
  assert.deepEqual(SETTINGS_DEFAULTS.transferColumnOrder, DEFAULT_COLUMN_ORDER);
});

test('a column added after an order was saved goes back to its own place', () => {
  // Saved by a version with no "Route" column, and with "Status" moved first.
  assert.deepEqual(
    sanitizeColumnOrder(['status', 'size', 'transferred', 'progress', 'speed', 'remaining']),
    ['route', 'status', 'size', 'transferred', 'progress', 'speed', 'remaining'],
  );
});

test('missing columns follow the column they come after by default', () => {
  assert.deepEqual(sanitizeColumnOrder(['status', 'size', 'route']), [
    'status',
    'size',
    'transferred',
    'progress',
    'speed',
    'remaining',
    'route',
  ]);
});

test('unknown and repeated entries are dropped', () => {
  assert.deepEqual(sanitizeColumnOrder(['size', 'bogus', 'size']), DEFAULT_COLUMN_ORDER);
  assert.deepEqual(sanitizeColumnOrder(undefined), DEFAULT_COLUMN_ORDER);
});
