import { readFile } from 'node:fs/promises';

const deny = await readFile('deny.toml', 'utf8');
const register = await readFile('docs/rust-advisories.md', 'utf8');
const ignored = new Set(
  [...deny.matchAll(/id\s*=\s*"(RUSTSEC-\d{4}-\d{4})"/g)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  ),
);
const rows = new Map<string, string[]>();

for (const line of register.split(/\r?\n/)) {
  if (!line.startsWith('| RUSTSEC-')) continue;
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
  const advisoryId = cells[0];
  if (advisoryId === undefined) continue;
  rows.set(advisoryId, cells);
}

const problems: string[] = [];
const denyLines = deny.split(/\r?\n/);
for (const advisory of ignored) {
  const row = rows.get(advisory);
  if (!row) {
    problems.push(`${advisory}: missing review-register entry`);
    continue;
  }
  const [, owner, added, reviewBy, status, control] = row;
  const exception = denyLines.find((line) => line.includes(`id = "${advisory}"`));
  if (!exception?.includes(`Review by ${reviewBy};`)) {
    problems.push(`${advisory}: deny.toml review date must match the register`);
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
  console.log(`${ignored.size} Rust advisory exceptions are documented and within review dates.`);
}
