import { readFile } from 'node:fs/promises';
import {
  advisoryKinds,
  ignoredAdvisories,
  parseAdvisoryRegister,
} from '../release/release-trust.ts';

const deny = await readFile('src-tauri/deny.toml', 'utf8');
const register = await readFile('docs/rust-advisories.md', 'utf8');
const ignored = new Set(ignoredAdvisories(deny));
const rows = parseAdvisoryRegister(register);

const problems: string[] = [];
const denyLines = deny.split(/\r?\n/);
for (const advisory of ignored) {
  const row = rows.get(advisory);
  if (!row) {
    problems.push(`${advisory}: missing review-register entry`);
    continue;
  }
  const { kind, owner, added, reviewBy, status, control } = row;
  const exception = denyLines.find((line) => line.includes(`id = "${advisory}"`));
  if (!exception?.includes(`Review by ${reviewBy};`)) {
    problems.push(`${advisory}: deny.toml review date must match the register`);
  }
  // A vulnerability and an unmaintained crate are different risks with
  // different exits; the register has to say which one it is accepting.
  if (!(advisoryKinds as readonly string[]).includes(kind)) {
    problems.push(`${advisory}: kind must be one of ${advisoryKinds.join(', ')}`);
  }
  if (!owner || !added || !reviewBy || !status || !control) {
    problems.push(`${advisory}: owner, dates, status, and compensating control are required`);
    continue;
  }
  const addedAt = Date.parse(`${added}T00:00:00Z`);
  const reviewAt = Date.parse(`${reviewBy}T23:59:59Z`);
  if (!Number.isFinite(addedAt) || !Number.isFinite(reviewAt)) {
    problems.push(`${advisory}: dates must use YYYY-MM-DD`);
  } else {
    if (reviewAt < Date.now()) problems.push(`${advisory}: review deadline has expired`);
    if (reviewAt - addedAt > 120 * 86_400_000) {
      problems.push(`${advisory}: review window exceeds 120 days`);
    }
  }
}

for (const advisory of rows.keys()) {
  if (!ignored.has(advisory)) problems.push(`${advisory}: register entry has no deny.toml ignore`);
}

if (problems.length) {
  console.error(`Rust advisory policy check failed:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  process.exitCode = 1;
} else {
  const counts = [...rows.values()].reduce<Record<string, number>>((acc, row) => {
    acc[row.kind] = (acc[row.kind] ?? 0) + 1;
    return acc;
  }, {});
  const breakdown = Object.entries(counts)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(', ');
  console.log(
    `${ignored.size} Rust advisory exceptions (${breakdown}) are documented and within review dates.`,
  );
}
