/**
 * Bidirectional isolation for text this app did not author — file and folder
 * names, hostnames, remote paths.
 *
 * The Unicode bidirectional algorithm resolves a whole paragraph at once, so
 * an Arabic or Hebrew filename dropped into an English sentence (or the
 * reverse) reorders the words *around* it: "Delete report.txt?" can render
 * with its punctuation on the wrong side of the verb. Isolating the foreign
 * run confines the reordering to the run itself.
 *
 * In markup that isolation is `<bdi>`, which needs no helper. In a plain-text
 * attribute — `aria-label`, `title`, a string handed to `window.alert` —
 * markup never arrives, so the same job falls to these characters.
 */

/**
 * U+2068 FIRST STRONG ISOLATE: takes its direction from the text's own first
 * strong character, which is exactly what `<bdi>` does in markup.
 */
const FIRST_STRONG_ISOLATE = '⁨';
/** U+2069 POP DIRECTIONAL ISOLATE: closes the run opened above. */
const POP_DIRECTIONAL_ISOLATE = '⁩';

/**
 * Wraps `text` so the surrounding sentence keeps its own word order.
 *
 * Two limits on where this belongs. In rendered markup use `<bdi>` instead —
 * it says the same thing without putting invisible characters into text the
 * user can copy. And only reach for it when the name is *inside* something
 * else: an attribute whose whole value is the name has no neighbouring words
 * to protect, so isolating it buys nothing and only makes the value harder to
 * match against.
 */
export function isolate(text: string): string {
  return `${FIRST_STRONG_ISOLATE}${text}${POP_DIRECTIONAL_ISOLATE}`;
}
