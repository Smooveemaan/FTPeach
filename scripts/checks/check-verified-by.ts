// The user guide states only what something checks. Each statement carries a
// hidden marker naming that check and where it runs:
//
//   <!-- verified-by: pr src-tauri/src/protocol/transfer_file.rs::resume_requires_the_same_endpoint_path_size_and_version -->
//   <!-- verified-by: pr test/unit/file-browser/paneFileOperations.test.ts::rename and move replace a target only on an explicit decision -->
//   <!-- verified-by: manual <heading in docs/manual-checks.md> -->
//
// This proves the named check exists, is not switched off, and runs where the
// marker says: `pr` blocks every change, `weekly` runs against real servers on
// a schedule, `manual` is a recorded run by a person. It does not prove the
// check asserts what the sentence says; that is still read in review.
import { readFile } from 'node:fs/promises';
import { ignoredTests } from './check-ignored-tests.ts';

export const GUIDE = 'docs/user-guide.md';
export const MANUAL_CHECKS = 'docs/manual-checks.md';

export type Gate = 'pr' | 'weekly' | 'manual';

export interface Marker {
  line: number;
  gate: string;
  target: string;
}

export function markers(markdown: string): Marker[] {
  const found: Marker[] = [];
  markdown.split('\n').forEach((text, index) => {
    for (const match of text.matchAll(/<!--\s*verified-by:\s*(\S+)\s+(.+?)\s*-->/g)) {
      found.push({ line: index + 1, gate: match[1]!, target: match[2]! });
    }
  });
  return found;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Where a test in `file` runs, or why it does not count. Ignored Rust tests
 * under `src-tauri/tests/` are the Docker suites the weekly workflows run with
 * `--ignored`; an ignored test anywhere else runs nowhere on its own.
 */
export function gateOf(file: string, source: string, name: string): Gate | string {
  if (file.endsWith('.rs')) {
    const declared = new RegExp(
      // Only attributes and comments may sit between `#[test]` and its fn.
      `#\\[(?:tokio::)?test[^\\]]*\\]\\s*(?:(?:#\\[[^\\]]*\\]|//[^\\n]*)\\s*)*(?:async\\s+)?fn\\s+${escape(name)}\\s*\\(`,
    );
    if (!declared.test(source)) return `no test fn \`${name}\` in ${file}`;
    if (!ignoredTests(file, source).some((test) => test.name === name)) return 'pr';
    return file.startsWith('src-tauri/tests/')
      ? 'weekly'
      : `\`${name}\` is #[ignore] and no workflow runs it`;
  }
  if (/\.test\.tsx?$/.test(file)) {
    const quoted = `(?<quote>['"\`])${escape(name)}\\k<quote>`;
    const call = new RegExp(`\\b(?:test|it)(\\.(?:skip|todo|only))?\\(\\s*${quoted}`);
    const match = call.exec(source);
    if (!match) return `no test titled "${name}" in ${file}`;
    return match[1] === '.skip' || match[1] === '.todo' ? `"${name}" is switched off` : 'pr';
  }
  return `${file} is not a Rust or TypeScript test file`;
}

/** Problems with one marker; `read` returns a file's text or undefined. */
export async function markerProblems(
  marker: Marker,
  read: (_file: string) => Promise<string | undefined>,
): Promise<string[]> {
  const where = `${GUIDE}:${marker.line}`;
  if (marker.gate === 'manual') {
    const record = await read(MANUAL_CHECKS);
    const heading = new RegExp(`^#{2,4}\\s+${escape(marker.target)}\\s*$`, 'm');
    return record && heading.test(record)
      ? []
      : [`${where}: no "${marker.target}" heading in ${MANUAL_CHECKS}`];
  }
  if (marker.gate !== 'pr' && marker.gate !== 'weekly') {
    return [`${where}: gate "${marker.gate}" is not pr, weekly or manual`];
  }
  const split = marker.target.indexOf('::');
  if (split < 0) return [`${where}: expected <file>::<test name>, got "${marker.target}"`];
  const file = marker.target.slice(0, split);
  const name = marker.target.slice(split + 2);
  const source = await read(file);
  if (source === undefined) return [`${where}: ${file} does not exist`];
  const gate = gateOf(file, source, name);
  if (gate === marker.gate) return [];
  if (gate === 'pr' || gate === 'weekly') {
    return [`${where}: \`${name}\` runs on ${gate}, not ${marker.gate}`];
  }
  return [`${where}: ${gate}`];
}

if (import.meta.filename === process.argv[1]) {
  const read = (file: string) => readFile(file, 'utf8').catch(() => undefined);
  const found = markers((await read(GUIDE)) ?? '');
  const problems = (await Promise.all(found.map((marker) => markerProblems(marker, read)))).flat();
  if (found.length === 0) problems.push(`${GUIDE} has no verified-by markers`);
  if (problems.length > 0) {
    console.error(`User guide statements lost their checks:\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log(`Verified-by check OK: ${found.length} marker(s), each naming a check that runs`);
  }
}
