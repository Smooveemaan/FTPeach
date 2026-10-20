import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { guideSourcesHash, verifyGuideReview } from '../../../scripts/site/guide-review.ts';

test('publication requires the reviewed release, guide text and screenshots, independent of line endings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ftpeach-guide-review-'));
  try {
    await mkdir(path.join(root, 'docs/guide'), { recursive: true });
    await mkdir(path.join(root, 'site/images/guide'), { recursive: true });
    const text = path.join(root, 'docs/guide/index.md');
    const image = path.join(root, 'site/images/guide/panes.png');
    await writeFile(text, '# Guide\n\nReviewed text.\n');
    await writeFile(image, Buffer.from([0, 1, 2]));
    const review = { release: 'v0.5.0', sourcesSha256: await guideSourcesHash(root) };
    await writeFile(path.join(root, 'site/guide-review.json'), JSON.stringify(review));
    await verifyGuideReview(root, 'v0.5.0');
    await assert.rejects(verifyGuideReview(root, 'v0.6.0'), /downloads use v0.6.0/);
    await writeFile(text, '# Guide\r\n\r\nReviewed text.\r\n');
    await verifyGuideReview(root, 'v0.5.0');
    await writeFile(text, '# Guide\n\nAn unreleased feature.\n');
    await assert.rejects(verifyGuideReview(root, 'v0.5.0'), /sources changed|screenshots changed/);
    await writeFile(text, '# Guide\n\nReviewed text.\n');
    await writeFile(image, Buffer.from([0, 1, 3]));
    await assert.rejects(verifyGuideReview(root, 'v0.5.0'), /screenshots changed/);
    await writeFile(image, Buffer.from([0, 1, 2]));
    await writeFile(path.join(root, 'docs/guide/future.md'), '# Future\n');
    await assert.rejects(verifyGuideReview(root, 'v0.5.0'), /screenshots changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
