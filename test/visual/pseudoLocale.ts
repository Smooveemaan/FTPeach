/**
 * English made about 40% longer, accented and bracketed: `Save` becomes
 * `⟦Šåvé ~~⟧`. A layout that fits it fits the long translations, and text on
 * screen without the brackets never went through i18next.
 */
const ACCENTS: Record<string, string> = {
  a: 'å',
  e: 'é',
  i: 'î',
  o: 'ö',
  u: 'ü',
  y: 'ý',
  c: 'ç',
  n: 'ñ',
  s: 'š',
  z: 'ž',
  A: 'Å',
  E: 'É',
  I: 'Î',
  O: 'Ö',
  U: 'Ü',
  Y: 'Ý',
  C: 'Ç',
  N: 'Ñ',
  S: 'Š',
  Z: 'Ž',
};

export const PSEUDO_OPEN = '⟦';
export const PSEUDO_CLOSE = '⟧';

function pseudoString(value: string): string {
  // Interpolations ({{name}}) and nesting ($t(key)) pass through untouched.
  const parts = value.split(/(\{\{[^}]+\}\}|\$t\([^)]+\))/);
  const text = parts
    .map((part, index) => (index % 2 ? part : part.replace(/[a-zA-Z]/g, (ch) => ACCENTS[ch] ?? ch)))
    .join('');
  const letters = value.replace(/\{\{[^}]+\}\}|\$t\([^)]+\)/g, '').length;
  // Words of five, not one long run: a real translation can wrap between words.
  const padding = '~'.repeat(Math.max(1, Math.round(letters * 0.4))).replace(/~{5}(?=~)/g, '$& ');
  return `${PSEUDO_OPEN}${text} ${padding}${PSEUDO_CLOSE}`;
}

export function pseudoLocalize<T>(resource: T): T {
  if (typeof resource === 'string') return pseudoString(resource) as T;
  if (resource && typeof resource === 'object') {
    return Object.fromEntries(
      Object.entries(resource).map(([key, value]) => [key, pseudoLocalize(value)]),
    ) as T;
  }
  return resource;
}
