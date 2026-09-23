// Reading Rust source without a Rust parser: enough lexing to tell code from
// comments and literals, and to find the items only tests compile. Shared by
// the duplication and boundary checks so both see the same split.

/**
 * `source` split into what production builds compile and what only tests
 * compile. Both keep every line, blank where the other half is, so a clone's
 * line numbers still point into the real file.
 */
export function splitInlineTests(source: string): { production: string; tests: string } {
  const ranges = inlineTestRanges(source);
  const production = source.split('');
  const tests = source.split('');
  let cursor = 0;
  for (const [start, end] of ranges) {
    blank(tests, cursor, start);
    blank(production, start, end);
    cursor = end;
  }
  blank(tests, cursor, source.length);
  return { production: production.join(''), tests: tests.join('') };
}

function blank(chars: string[], start: number, end: number) {
  for (let index = start; index < end; index += 1) {
    if (chars[index] !== '\n') chars[index] = ' ';
  }
}

/** Offsets of every item marked `#[cfg(test)]`, attribute included. */
function inlineTestRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const pattern = /#\[cfg\(test\)\]/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    if (!isCode(source, match.index)) continue;
    const end = itemEnd(source, match.index + match[0].length);
    ranges.push([match.index, end]);
    pattern.lastIndex = end;
  }
  return ranges;
}

/** Whether `offset` is outside comments and literals. */
function isCode(source: string, offset: number): boolean {
  let code = true;
  scan(source, 0, (index, inCode) => {
    if (index === offset) {
      code = inCode;
      return true;
    }
    return false;
  });
  return code;
}

/** Where the item starting at `from` ends: after its `;` or its closing `}`. */
function itemEnd(source: string, from: number): number {
  let depth = 0;
  let end = source.length;
  scan(source, from, (index, inCode) => {
    if (!inCode) return false;
    const char = source[index];
    // Other attributes on the same item, `#[...]`, keep brackets balanced
    // and never contain the item's own `;` or `{`.
    if (char === '[' || char === '(') depth += 1;
    else if (char === ']' || char === ')') depth -= 1;
    else if (depth === 0 && char === ';') {
      end = index + 1;
      return true;
    } else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        // `use a::{b, c};` goes on to its semicolon; a block item ends here.
        const semicolon = /^\s*;/.exec(source.slice(index + 1));
        end = index + 1 + (semicolon ? semicolon[0].length : 0);
        return true;
      }
    }
    return false;
  });
  return end;
}

/**
 * Walks `source` from `from`, calling `visit(index, inCode)` per character
 * until it returns true. Skips line and block comments, string, raw string
 * and byte string literals and char literals; a `'` that opens a lifetime is
 * code.
 */
function scan(source: string, from: number, visit: (_index: number, _inCode: boolean) => boolean) {
  let index = from;
  const skip = (to: number) => {
    for (; index < to && index < source.length; index += 1) {
      if (visit(index, false)) return true;
    }
    return false;
  };
  while (index < source.length) {
    const rest = source.slice(index, index + 3);
    if (rest.startsWith('//')) {
      const end = source.indexOf('\n', index);
      if (skip(end < 0 ? source.length : end)) return;
      continue;
    }
    if (rest.startsWith('/*')) {
      let depth = 0;
      let end = index;
      do {
        if (source.startsWith('/*', end)) {
          depth += 1;
          end += 2;
        } else if (source.startsWith('*/', end)) {
          depth -= 1;
          end += 2;
        } else end += 1;
      } while (depth > 0 && end < source.length);
      if (skip(end)) return;
      continue;
    }
    const raw = /^b?r(#*)"/.exec(source.slice(index, index + 260));
    if (raw && (index === 0 || !/[\w]/.test(source[index - 1]!))) {
      const closing = `"${raw[1]}`;
      const end = source.indexOf(closing, index + raw[0].length);
      if (skip(end < 0 ? source.length : end + closing.length)) return;
      continue;
    }
    if (source[index] === '"' || (source[index] === 'b' && source[index + 1] === '"')) {
      let end = source.indexOf('"', index) + 1;
      while (end < source.length && source[end] !== '"') end += source[end] === '\\' ? 2 : 1;
      if (skip(end + 1)) return;
      continue;
    }
    if (source[index] === "'") {
      const char = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\'])'/u.exec(
        source.slice(index, index + 12),
      );
      if (char) {
        if (skip(index + char[0].length)) return;
        continue;
      }
    }
    if (visit(index, true)) return;
    index += 1;
  }
}

/** `source` with comments and string and char literals blanked, lines kept. */
export function codeOnly(source: string): string {
  const chars = source.split('');
  scan(source, 0, (index, inCode) => {
    if (!inCode && chars[index] !== '\n') chars[index] = ' ';
    return false;
  });
  return chars.join('');
}

/** Whether a file holds only tests: `tests.rs` or `*_tests.rs`. */
export const isTestFile = (file: string) => /(^|[\\/])(tests|\w+_tests)\.rs$/.test(file);
