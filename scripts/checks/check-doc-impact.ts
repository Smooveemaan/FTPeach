// A change to what the client does has to reach the page that describes it.
// Nothing tied the two together, so docs drifted behind the code one forgotten
// update at a time. This does not judge whether a document is right, only that
// a change which usually needs a document update either has one or says in its
// commit message why it does not:
//
//   Docs-Impact: none - internal refactor, behavior unchanged
//   Changelog: none - tests only
//
// The two are separate on purpose: a bug fix can restore behavior the guide
// already describes and still deserve a changelog line.
import { execFileSync } from 'node:child_process';

export interface DocLink {
  code: RegExp;
  docs: readonly string[];
}

/**
 * Code whose changes usually change a document. Kept short on purpose: a link
 * that fires on most edits gets waved through, and that teaches nothing.
 */
export const DOC_LINKS: readonly DocLink[] = [
  {
    code: /^src-tauri\/src\/protocol\//,
    docs: ['docs/protocol-support.md', 'docs/networking.md', 'docs/user-guide.md'],
  },
  {
    code: /^src-tauri\/src\/(?:transfer|application)\/|^src-tauri\/src\/protocol\/transfer_file\.rs$/,
    docs: ['docs/transfer-safety.md', 'docs/user-guide.md'],
  },
  {
    code: /^src-tauri\/src\/(?:store|security)\//,
    docs: ['docs/storage.md', 'docs/security.md', 'docs/user-guide.md'],
  },
  {
    code: /^src-tauri\/capabilities\//,
    docs: ['docs/ipc-permissions.md'],
  },
  {
    code: /^src-tauri\/src\/runtime\/(?:updater|update_staging)/,
    docs: ['docs/updater-signing.md'],
  },
];

/** Code a user can notice changing: the app itself, not its tests. */
const USER_FACING = /^src\/|^src-tauri\/src\/|^src-tauri\/tauri\.conf\.json$/;
const TEST_ONLY = /(?:^|\/)tests?\/|_tests\.rs$|(?:^|\/)tests\.rs$|\.test\.tsx?$/;

export const CHANGELOG = 'CHANGELOG.md';

export interface Exemptions {
  docs: string | undefined;
  changelog: string | undefined;
}

/**
 * Reasons given in commit messages. Only `none` followed by a reason counts:
 * a bare `none` would be the formality this check exists to avoid.
 */
export function readExemptions(messages: string): Exemptions {
  const reason = (key: string) =>
    [...messages.matchAll(new RegExp(`^${key}:\\s*none\\s*[-:—–]\\s*(\\S.*)$`, 'gim'))]
      .map((match) => match[1]!.trim())
      .find((text) => text.length > 0);
  return { docs: reason('Docs-Impact'), changelog: reason('Changelog') };
}

/** What the change set still owes, as messages for the author. */
export function docImpactProblems(paths: Iterable<string>, exemptions: Exemptions): string[] {
  const changed = new Set([...paths].map((path) => path.trim()).filter(Boolean));
  const problems: string[] = [];

  if (!exemptions.docs) {
    for (const link of DOC_LINKS) {
      const code = [...changed].filter((path) => link.code.test(path) && !TEST_ONLY.test(path));
      if (code.length === 0 || link.docs.some((doc) => changed.has(doc))) continue;
      problems.push(
        `${code.join(', ')} changed, but none of ${link.docs.join(', ')} did. ` +
          'Update the one that describes this, or add "Docs-Impact: none - <reason>" to the commit message.',
      );
    }
  }

  if (!exemptions.changelog && !changed.has(CHANGELOG)) {
    const code = [...changed].filter((path) => USER_FACING.test(path) && !TEST_ONLY.test(path));
    if (code.length > 0) {
      problems.push(
        `${code.length} app file(s) changed (${code.slice(0, 3).join(', ')}${code.length > 3 ? ', ...' : ''}), ` +
          `but ${CHANGELOG} did not. Add a line under [Unreleased] if users will notice, ` +
          'or add "Changelog: none - <reason>" to the commit message.',
      );
    }
  }
  return problems;
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * The commits to judge: CI passes the pushed range; locally it is what has not
 * been pushed yet. Commits older than this script are left out, because they
 * were written before the rule existed and cannot be reworded after the fact.
 */
function commitRange(): string[] | string {
  const zero = /^0+$/;
  let base = process.env.BASE_SHA ?? '';
  const head = process.env.HEAD_SHA || 'HEAD';
  if (!process.env.BASE_SHA) {
    try {
      base = git('rev-parse', '--verify', '--quiet', '@{upstream}').trim();
    } catch {
      return 'no upstream branch to compare against';
    }
  }
  if (base === '' || zero.test(base)) return 'no base commit to compare against';
  try {
    git('cat-file', '-e', `${base}^{commit}`);
  } catch {
    return 'the base commit is unreachable';
  }
  const range = [`${base}..${head}`];
  const added = git(
    'log',
    '--diff-filter=A',
    '--format=%H',
    '-1',
    head,
    '--',
    'scripts/checks/check-doc-impact.ts',
  ).trim();
  if (added) range.push(`^${added}^`);
  return range;
}

if (import.meta.filename === process.argv[1]) {
  const range = commitRange();
  if (typeof range === 'string') {
    console.log(`Doc-impact check skipped: ${range}`);
  } else {
    const messages = git('log', '--format=%B', ...range);
    const paths = git('log', '--format=', '--name-only', '--no-renames', ...range).split(/\r?\n/);
    const problems = docImpactProblems(paths, readExemptions(messages));
    if (problems.length > 0) {
      console.error(`Documentation may be out of date:\n- ${problems.join('\n- ')}`);
      process.exitCode = 1;
    } else {
      const count = git('rev-list', '--count', ...range).trim();
      console.log(`Doc-impact check OK: ${count} commit(s) checked`);
    }
  }
}
