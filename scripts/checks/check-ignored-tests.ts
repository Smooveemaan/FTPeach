// An ignored Rust test is a check that did not run. Each one must say why in
// its attribute and be listed in docs/verification-matrix.md with what it
// needs and how to run it, so a skipped check is never mistaken for a pass.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const registryPath = 'docs/verification-matrix.md';
const roots = ['src-tauri/src', 'src-tauri/tests'];

export interface IgnoredTest {
  file: string;
  line: number;
  name: string;
  reason: string | undefined;
}

/** Every `#[ignore]` attribute in `source` with the test function it marks. */
export function ignoredTests(file: string, source: string): IgnoredTest[] {
  const lines = source.split('\n');
  const found: IgnoredTest[] = [];
  lines.forEach((text, index) => {
    const attribute = /^\s*#\[ignore(?:\s*=\s*"([^"]*)")?\s*\]/.exec(text);
    if (!attribute) return;
    const rest = lines.slice(index + 1).join('\n');
    const name = /\bfn\s+(\$?\w+)/.exec(rest)?.[1] ?? '?';
    found.push({ file, line: index + 1, name, reason: attribute[1]?.trim() || undefined });
  });
  return found;
}

/** Whether the registry lists the test by name, by file or by its folder. */
export function isRegistered(test: IgnoredTest, registry: string): boolean {
  const keys = [test.name, test.file, `${path.posix.dirname(test.file)}/`];
  return keys.some((key) => registry.includes(`\`${key}\``));
}

async function rustFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.rs'))
    .map((entry) => path.posix.join(entry.parentPath.replaceAll('\\', '/'), entry.name));
}

if (import.meta.main) {
  const registry = await readFile(registryPath, 'utf8');
  const files = (await Promise.all(roots.map(rustFiles))).flat();
  const tests = (
    await Promise.all(files.map(async (file) => ignoredTests(file, await readFile(file, 'utf8'))))
  ).flat();
  const problems = tests.flatMap((test) => [
    ...(test.reason ? [] : [`${test.file}:${test.line} ${test.name}: #[ignore] gives no reason`]),
    ...(isRegistered(test, registry)
      ? []
      : [`${test.file}:${test.line} ${test.name}: not listed in ${registryPath}`]),
  ]);
  if (problems.length > 0) {
    console.error(`Ignored tests need a reason and a registry entry:\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Ignored-test check OK: ${tests.length} #[ignore] attribute(s), all explained and registered`,
    );
  }
}
