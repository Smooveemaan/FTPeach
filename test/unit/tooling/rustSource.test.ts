import assert from 'node:assert/strict';
import test from 'node:test';
import { splitInlineTests } from '../../../scripts/checks/rust-source.ts';

const lines = (text: string) => text.split('\n').map((line) => line.trim());

test('inline test modules move to the test half and keep every line number', () => {
  const source = [
    'pub fn real() -> u8 {',
    '    1',
    '}',
    '',
    '#[cfg(test)]',
    'mod tests {',
    '    #[test]',
    '    fn braces_in_literals_do_not_end_the_module() {',
    '        let _ = ("}", \'}\', r#"}"#, b"}");',
    '        // }',
    '        /* } */',
    '    }',
    '}',
    '',
    "pub fn after<'a>(value: &'a str) -> &'a str {",
    '    value',
    '}',
  ].join('\n');
  const { production, tests } = splitInlineTests(source);
  assert.equal(production.length, source.length);
  assert.equal(tests.length, source.length);
  assert.deepEqual(lines(production), [
    'pub fn real() -> u8 {',
    '1',
    '}',
    '',
    ...Array(9).fill(''),
    '',
    "pub fn after<'a>(value: &'a str) -> &'a str {",
    'value',
    '}',
  ]);
  assert.deepEqual(lines(tests).slice(4, 13), lines(source).slice(4, 13));
  assert.equal(lines(tests).slice(0, 4).join(''), '');
  assert.equal(lines(tests).slice(13).join(''), '');
});

test('a test-only declaration ends at its semicolon, attributes included', () => {
  const source = [
    'use std::io;',
    '#[cfg(test)]',
    '#[path = "x_tests.rs"]',
    'mod x_tests;',
    '#[cfg(test)]',
    'use crate::fixtures::{a, b};',
    'fn kept() {}',
  ].join('\n');
  const { production } = splitInlineTests(source);
  assert.deepEqual(lines(production), ['use std::io;', '', '', '', '', '', 'fn kept() {}']);
});

test('the attribute inside a comment or a string is not a test item', () => {
  const source = ['// #[cfg(test)]', 'const S: &str = "#[cfg(test)]";', 'fn kept() {}'].join('\n');
  assert.equal(splitInlineTests(source).production, source);
});

test('characters outside the Basic Multilingual Plane do not shift the split', () => {
  const source = [
    'const E: &str = "\u{1F600}";',
    '#[cfg(test)]',
    'mod tests {}',
    'fn kept() {}',
  ].join('\n');
  assert.deepEqual(lines(splitInlineTests(source).production), [
    'const E: &str = "\u{1F600}";',
    '',
    '',
    'fn kept() {}',
  ]);
});
