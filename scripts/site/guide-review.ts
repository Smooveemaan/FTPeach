import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/** Identify the exact guide texts and illustrations reviewed for a release. */
export async function guideSourcesHash(root: string): Promise<string> {
  const files: string[] = [];
  for (const directory of ['docs/guide', 'site/images/guide']) {
    for (const entry of await readdir(path.join(root, directory), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (entry.isFile())
        files.push(
          path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
        );
    }
  }
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    const bytes = await readFile(path.join(root, file));
    const content = file.endsWith('.md') ? bytes.toString('utf8').replaceAll('\r\n', '\n') : bytes;
    hash.update(file).update('\0').update(createHash('sha256').update(content).digest());
  }
  return hash.digest('hex');
}

/** Stop publication until the changed guide has been reviewed for the downloadable app. */
export async function verifyGuideReview(root: string, release: string): Promise<void> {
  const review = JSON.parse(await readFile(path.join(root, 'site/guide-review.json'), 'utf8'));
  assert.equal(
    review.release,
    release,
    `Guide review is for ${review.release}, but downloads use ${release}. Review the guide for the released app.`,
  );
  assert.equal(
    review.sourcesSha256,
    await guideSourcesHash(root),
    'Guide texts or screenshots changed since their release review. Follow CONTRIBUTING.md before updating guide-review.json.',
  );
}

if (import.meta.filename === process.argv[1])
  console.log(await guideSourcesHash(path.resolve(import.meta.dirname, '../..')));
