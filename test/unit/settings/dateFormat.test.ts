import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import i18n from '../../../src/i18n/index.ts';
import {
  createDateFormatter,
  createLogTimeFormatter,
} from '../../../src/features/settings/dateFormat.ts';

// Make date expectations deterministic across developer machines and CI.
process.env.TZ = 'UTC';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

test('an unusable date renders as an em dash', () => {
  const formatDate = createDateFormatter('locale', null);
  assert.equal(formatDate(null), '—');
  assert.equal(formatDate(undefined), '—');
  assert.equal(formatDate('not a date'), '—');
});

test('a valid date renders in the browser locale', () => {
  const input = '2026-03-05T12:30:00Z';
  const formatted = createDateFormatter('locale', null)(input);
  const expected = new Date(input)
    .toLocaleDateString(undefined, {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    })
    .replace(/,\s*/, ' ');
  assert.notEqual(formatted, '—');
  assert.equal(formatted, expected);
  assert.doesNotMatch(formatted, /,/);
});

test('locale date format follows the browser locale rather than the interface language', async () => {
  const input = '2026-03-05T13:07:00Z';
  await i18n.changeLanguage('ru');

  const expected = new Date(input)
    .toLocaleDateString(undefined, {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    .replace(/,\s*/, ' ');

  assert.equal(createDateFormatter('locale', null)(input), expected);
});

test('locale date format honors an explicit system 24-hour cycle', () => {
  const input = '2026-03-05T13:07:00Z';
  const formatDate = createDateFormatter('locale', 'h23');

  assert.doesNotMatch(formatDate(input), /AM|PM/i);
  assert.match(formatDate(input), /13:07/);
});

test('the common explicit date and time formats are supported', () => {
  const input = '2026-03-05T13:07:00Z';

  assert.equal(createDateFormatter('dd/MM/yyyy HH:mm', null)(input), '05/03/2026 13:07');
  assert.equal(createDateFormatter('MM-dd-yyyy hh:mm a', null)(input), '03-05-2026 01:07 PM');
  assert.equal(createDateFormatter('yyyy-MM-dd HH:mm', null)(input), '2026-03-05 13:07');
});

test('a non-string preference falls back to the locale format', () => {
  const input = '2026-03-05T13:07:00Z';
  assert.equal(
    createDateFormatter(undefined, null)(input),
    createDateFormatter('locale', null)(input),
  );
});

test('log timestamps carry milliseconds and follow the 12- or 24-hour preference', () => {
  const at = Date.parse('2026-03-05T13:07:09.042Z');

  const twentyFour = createLogTimeFormatter('dd.MM.yyyy HH:mm', null);
  assert.equal(twentyFour.time(at), '13:07:09.042');
  assert.equal(twentyFour.dateTime(at), '05.03.2026 13:07:09.042');

  const twelve = createLogTimeFormatter('MM/dd/yyyy hh:mm a', null);
  assert.equal(twelve.time(at), '01:07:09.042 PM');
  assert.equal(twelve.dateTime(at), '03/05/2026 01:07:09.042 PM');

  assert.equal(createLogTimeFormatter('iso', null).dateTime(at), '2026-03-05 13:07:09.042');
});

test('locale log timestamps keep milliseconds and the system hour cycle', () => {
  const at = Date.parse('2026-03-05T13:07:09.042Z');
  const time = createLogTimeFormatter('locale', 'h23').time(at);
  assert.match(time, /13.07.09.042/);
  assert.doesNotMatch(time, /AM|PM/i);
});

// Each formatter above was built from its own arguments: no shared preference
// to set, and no reset to forget. That is the point of splitting the pure
// factory out of the store in `features/settings/dateFormat.ts`.
