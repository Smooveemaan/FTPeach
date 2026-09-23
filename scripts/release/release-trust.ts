// What a release can honestly claim about the binary it publishes. Three
// separate trust mechanisms are easy to blur into one "it is signed":
//
//   * the minisign updater signature, which only the updater checks;
//   * Windows Authenticode, which is what Explorer and SmartScreen check on
//     the first download -- and which FTPeach does not have yet;
//   * the RustSec exceptions the build was allowed to carry.
//
// The pure verdicts live here so they can be tested without a Windows
// runner, a signed binary or the GitHub API.

/** RustSec advisory classes. An `informational` advisory names its class. */
export const advisoryKinds = ['vulnerability', 'unmaintained', 'unsound', 'notice'] as const;
export type AdvisoryKind = (typeof advisoryKinds)[number];

export interface AdvisoryException {
  id: string;
  kind: string;
  owner: string;
  added: string;
  reviewBy: string;
  status: string;
  control: string;
}

/** Rows of the `docs/rust-advisories.md` register table, keyed by advisory id. */
export function parseAdvisoryRegister(markdown: string): Map<string, AdvisoryException> {
  const rows = new Map<string, AdvisoryException>();
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith('| RUSTSEC-')) continue;
    const [id = '', kind = '', owner = '', added = '', reviewBy = '', status = '', control = ''] =
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
    rows.set(id, { id, kind, owner, added, reviewBy, status, control });
  }
  return rows;
}

/** Advisory ids that `deny.toml` tells cargo-deny to ignore. */
export function ignoredAdvisories(denyToml: string): string[] {
  return [...denyToml.matchAll(/id\s*=\s*"(RUSTSEC-\d{4}-\d{4})"/g)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );
}

/**
 * The class RustSec itself gives an advisory: `informational = "…"` for the
 * non-vulnerability kinds, nothing for a vulnerability.
 */
export function rustsecKind(advisoryMarkdown: string): AdvisoryKind | undefined {
  const informational = advisoryMarkdown.match(/^informational\s*=\s*"([a-z-]+)"/m)?.[1];
  if (informational === undefined) return 'vulnerability';
  return advisoryKinds.find((kind) => kind === informational);
}

export interface AuthenticodeResult {
  /** `System.Management.Automation.SignatureStatus` name, e.g. `Valid`. */
  status: string;
  signer?: string | undefined;
  timestamped: boolean;
}

export type Verdict = { ok: true; summary: string } | { ok: false; summary: string };

/**
 * An unsigned binary is the known, documented state and is reported as such.
 * A signature that exists but does not verify, or that carries no timestamp
 * and so dies with its certificate, is a broken release.
 */
export function authenticodeVerdict(file: string, result: AuthenticodeResult): Verdict {
  if (result.status === 'NotSigned') {
    return {
      ok: true,
      summary: `${file}: not Authenticode-signed (accepted risk; see docs/release-trust.md)`,
    };
  }
  if (result.status !== 'Valid') {
    return { ok: false, summary: `${file}: Authenticode signature is ${result.status}` };
  }
  if (!result.timestamped) {
    return {
      ok: false,
      summary: `${file}: Authenticode signature by ${result.signer ?? 'unknown signer'} has no timestamp`,
    };
  }
  return {
    ok: true,
    summary: `${file}: Authenticode-signed by ${result.signer ?? 'unknown signer'}, timestamped`,
  };
}

/** The subset of GitHub's environment resource this gate reads. */
export interface GithubEnvironment {
  can_admins_bypass?: boolean;
  protection_rules?: { type: string; reviewers?: unknown[] }[];
}

/**
 * `environment: release` in the workflow only names an environment. Whether
 * anyone has to approve a run before it reaches the signing secrets is a
 * repository setting the workflow cannot see -- so it is read, not assumed.
 */
export function environmentVerdict(environment: GithubEnvironment): Verdict {
  const reviewers = (environment.protection_rules ?? [])
    .filter((rule) => rule.type === 'required_reviewers')
    .reduce((count, rule) => count + (rule.reviewers?.length ?? 0), 0);
  const problems: string[] = [];
  if (reviewers === 0) problems.push('no required reviewers');
  if (environment.can_admins_bypass !== false) problems.push('administrators can bypass approval');
  if (problems.length > 0) {
    return {
      ok: false,
      summary: `The release environment does not guard the signing secrets: ${problems.join('; ')}`,
    };
  }
  return {
    ok: true,
    summary: `The release environment requires approval from ${reviewers} reviewer(s), without administrator bypass`,
  };
}

/** Header lines minisign writes in front of a secret key file. */
export const secretKeyMarkers = [
  'untrusted comment: rsign encrypted secret key',
  'minisign encrypted secret key',
];

/**
 * Where `contents` carries the updater's private key: the exact secret the
 * build was given, the decoded key file, or a secret-key header. Short
 * secrets are ignored so an empty or placeholder value cannot match anything.
 */
export function privateKeyHits(contents: Buffer, secret: string | undefined): string[] {
  const hits: string[] = [];
  const needles = new Map<string, string>();
  const trimmed = secret?.trim() ?? '';
  if (trimmed.length >= 32) {
    needles.set('the updater private key', trimmed);
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    for (const line of decoded.split(/\r?\n/)) {
      if (line.trim().length >= 32 && !line.startsWith('untrusted comment:')) {
        needles.set('the decoded updater private key', line.trim());
      }
    }
  }
  for (const marker of secretKeyMarkers) needles.set(`a "${marker}" header`, marker);
  for (const [label, needle] of needles) {
    if (contents.includes(needle)) hits.push(label);
  }
  return hits;
}

/**
 * The release matrix of `docs/verification-matrix.md` as report lines. A
 * `ci` row is proven by a job the publish job needs; every other row is
 * printed as not verified, because this workflow cannot have run it.
 */
export function releaseMatrixLines(markdown: string): string[] {
  const section = markdown.split(/^## Release matrix$/m)[1]?.split(/^## /m)[0] ?? '';
  const rows = section
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*(-|Cell\b)/.test(line));
  if (rows.length === 0) throw new Error('docs/verification-matrix.md has no release matrix');
  return rows.map((row) => {
    const [cell, lane, how] = row
      .split('|')
      .slice(1, 4)
      .map((column) => column.trim());
    return lane === 'ci'
      ? `| ${cell} | passed: required job, ${how} |`
      : `| ${cell} | **NOT VERIFIED** by this workflow: ${how} |`;
  });
}
