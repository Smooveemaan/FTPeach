/**
 * Global setup of the i18n layout audit: clears the last run's findings, and
 * returns the teardown that folds this run's findings into
 * test-results/i18n-audit/summary.md — one line per problem, with every
 * language that has it, most widespread first.
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
}

export default function setup() {
  rmSync(findings, { recursive: true, force: true });
  return summarize;
}
