/**
 * Global setup of the i18n layout audit: clears the last run's findings, and
 * returns the teardown that folds this run's findings into
 * test-results/i18n-audit/summary.md — one line per problem, with every
 * language that has it, most widespread first. A problem not among the known
 * ones below fails the run.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LayoutProblem } from './layoutAudit.ts';

const root = join(import.meta.dirname, '../../test-results/i18n-audit');
const findings = join(root, 'findings');

interface Finding {
  language: string;
  state: string;
  problems: LayoutProblem[];
}

/**
 * Problems looked at and left as they are: kind and element, the languages
 * that have it, and why. Any other problem, or one of these in another
 * language, fails the run.
 */
const KNOWN: { kind: string; where: string; languages: string[]; why: string }[] = [
  {
    kind: 'truncated',
    where: 'div.pane-body > div.row.row-header > span.col-header.sortable > span.col-header-label',
    languages: ['pseudo'],
    why: 'a column header too narrow for its name ends in an ellipsis and shows the name as a tooltip; every real language fits',
  },
  {
    kind: 'wraps',
    where: 'div.app-shell > div.menu-bar > div.menu-bar-item > button.menu-bar-trigger',
    languages: ['pseudo'],
    why: 'the pseudo-locale lengthens a short menu title far past any translation; every real language fits the smallest window',
  },
];

interface Group {
  problem: LayoutProblem;
  states: Set<string>;
  /** Language → the worst instance's text and detail. */
  languages: Map<string, string>;
}

function summarize() {
  if (!existsSync(findings)) return;
  const groups = new Map<string, Group>();
  let snapshots = 0;
  for (const language of readdirSync(findings)) {
    const dir = join(findings, language);
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
      const finding = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Finding;
      snapshots += 1;
      for (const problem of finding.problems) {
        // The same element misbehaves behind every menu and dialog: one entry, all its states.
        const key = `${problem.kind}|${problem.where}`;
        const group = groups.get(key) ?? { problem, states: new Set(), languages: new Map() };
        group.states.add(finding.state);
        if (!group.languages.has(language)) {
          group.languages.set(language, `${problem.text.slice(0, 80)} — ${problem.detail}`);
        }
        groups.set(key, group);
      }
    }
  }
  // Problems English has too do not come from a translation; they go last.
  const ranked = [...groups.values()].sort(
    (a, b) =>
      Number(a.languages.has('en')) - Number(b.languages.has('en')) ||
      b.languages.size - a.languages.size ||
      a.problem.kind.localeCompare(b.problem.kind),
  );
  const counts = new Map<string, number>();
  for (const group of ranked) {
    counts.set(group.problem.kind, (counts.get(group.problem.kind) ?? 0) + 1);
  }
  const headline = `${snapshots} snapshots, ${ranked.length} distinct problems (${[...counts]
    .map(([kind, count]) => `${kind} ${count}`)
    .join(', ')})`;
  const lines = [
    '# i18n layout audit',
    '',
    headline,
    '',
    'Screenshots with the problems outlined: findings/<language>/<state>.png',
    '',
  ];
  for (const group of ranked) {
    const english = group.languages.has('en') ? ' (English too)' : '';
    const states = [...group.states].sort();
    lines.push(`## ${group.problem.kind}${english}: \`${group.problem.where}\``);
    lines.push(
      `${group.languages.size} language(s); states: ${states.slice(0, 6).join(', ')}${states.length > 6 ? ` +${states.length - 6}` : ''}`,
    );
    for (const [language, text] of group.languages) lines.push(`- ${language}: ${text}`);
    lines.push('');
  }
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'summary.md'), lines.join('\n'));
  console.log(`\n${headline}\nReport: ${join(root, 'summary.md')}`);
  const unexpected = ranked.flatMap(({ problem, languages }) => {
    const known = KNOWN.find(
      (entry) => entry.kind === problem.kind && entry.where === problem.where,
    );
    const others = [...languages.keys()].filter((language) => !known?.languages.includes(language));
    return others.length ? [`${problem.kind} \`${problem.where}\` in ${others.join(', ')}`] : [];
  });
  if (unexpected.length > 0) {
    throw new Error(`The layout lets the text down (summary.md):\n${unexpected.join('\n')}`);
  }
  checkShown();
}

/**
 * Every string in en.json is shown by some state in the pseudo-locale, or is
 * listed in i18nAuditUnshown.json: so a new screen without a state of its own
 * fails here instead of going unchecked. Only a whole run tells: a run of
 * some languages or some states skips it.
 */
function checkShown() {
  const pseudo = join(findings, 'pseudo');
  const partial = process.argv.some((arg) => arg === '-g' || arg.startsWith('--grep'));
  if (partial || !existsSync(pseudo)) return;
  const base = (key: string) => key.replace(/_(?:zero|one|two|few|many|other)$/, '');
  const shown = new Set<string>();
  for (const file of readdirSync(pseudo).filter((name) => name.endsWith('.json'))) {
    const finding = JSON.parse(readFileSync(join(pseudo, file), 'utf8')) as { shown: string[] };
    for (const key of finding.shown) shown.add(base(key));
  }
  const keys = new Set<string>();
  (function collect(node: object, prefix: string) {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') keys.add(base(prefix + key));
      else collect(value as object, `${prefix}${key}.`);
    }
  })(
    JSON.parse(readFileSync(join(import.meta.dirname, '../../src/i18n/locales/en.json'), 'utf8')),
    '',
  );
  const listed = JSON.parse(
    readFileSync(join(import.meta.dirname, 'i18nAuditUnshown.json'), 'utf8'),
  ) as { prefixes: Record<string, string>; keys: string[] };
  const prefixed = (key: string) => Object.keys(listed.prefixes).some((p) => key.startsWith(p));
  const missing = [...keys].filter(
    (key) => !shown.has(key) && !prefixed(key) && !listed.keys.includes(key),
  );
  const stale = listed.keys.filter((key) => shown.has(key) || !keys.has(key));
  const problems = [
    ...missing.map((key) => `${key}: no state shows it; give its screen a state, or list it`),
    ...stale.map((key) => `${key}: listed as never shown, but a state shows it or it is gone`),
  ];
  if (problems.length > 0) {
    throw new Error(`Strings and the audit (i18nAuditUnshown.json):\n${problems.join('\n')}`);
  }
}

export default function setup() {
  rmSync(findings, { recursive: true, force: true });
  return summarize;
}
