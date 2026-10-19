import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { buildGuide, GUIDE_PAGES, renderGuide } from '../../../scripts/site/guide.ts';

test('Markdown keeps tables, code and unique GitHub headings, rewrites links and hides verification comments', () => {
  const rendered = renderGuide(
    '# Guide\n\n## Pause & resume\n\n## Pause & resume\n\n[Passwords](passwords.md#unlocking-with-windows-hello) and [limits](../protocol-support.md#limitations).\n\n| Item | Value |\n| --- | --- |\n| Pause | `yes` |\n\n<!-- verified-by: pr secret.test.ts::test -->',
    'transfers',
  );
  assert.equal(rendered.title, 'Guide');
  const document = new JSDOM(rendered.content).window.document;
  assert.deepEqual(
    [...document.querySelectorAll('h2')].map((heading) => heading.id),
    ['pause--resume', 'pause--resume-1'],
  );
  assert.equal(
    document.querySelector('a')?.getAttribute('href'),
    'passwords.html#unlocking-with-windows-hello',
  );
  assert.equal(
    document.querySelectorAll('a')[1]?.getAttribute('href'),
    'https://github.com/Smooveemaan/ftpeach/blob/master/docs/protocol-support.md#limitations',
  );
  assert.equal(document.querySelector('table code')?.textContent, 'yes');
  assert.doesNotMatch(rendered.content, /verified-by|secret\.test/);
  assert.match(rendered.toc, /href="#pause--resume-1"/);
  assert.match(
    renderGuide('# Guide\n\n## Pause & resume', 'transfers').content,
    /id="pause--resume"/,
  );
});

test('invalid guide sources fail the build instead of publishing unsafe or broken content', () => {
  for (const markdown of [
    'No title',
    '# One\n\n# Two',
    '# Guide\n\n<script>alert(1)</script>',
    '# Guide\n\n[bad](javascript:alert)',
    '# Guide\n\n[missing](missing.md)',
    '# Guide\n\n[outside](../../../outside.md)',
  ]) {
    assert.throws(() => renderGuide(markdown, 'index'));
  }
});

test('every built guide page has metadata, working navigation and matching sitemap entries', async () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  const out = await mkdtemp(path.join(os.tmpdir(), 'ftpeach-guide-'));
  try {
    await buildGuide(root, out);
    const sitemap = new JSDOM(await readFile(path.join(out, 'sitemap.xml'), 'utf8'), {
      contentType: 'text/xml',
    }).window.document;
    const urls = [...sitemap.querySelectorAll('loc')].map((node) => node.textContent);
    assert.equal(urls.length, GUIDE_PAGES.length + 1);
    const documents = new Map<string, Document>();
    for (const page of GUIDE_PAGES) {
      const html = await readFile(path.join(out, `guide/${page.slug}.html`), 'utf8');
      const document = new JSDOM(html).window.document;
      documents.set(`${page.slug}.html`, document);
      assert.ok(document.title.endsWith(' · FTPeach Guide'));
      assert.equal(
        document.querySelector('meta[name="description"]')?.getAttribute('content'),
        page.description,
      );
      assert.ok(
        urls.includes(document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? ''),
      );
      assert.equal(document.querySelectorAll('h1').length, 1);
      assert.equal(
        document.querySelector('a[aria-current="page"]')?.getAttribute('href'),
        `${page.slug}.html`,
      );
      assert.equal(
        document.querySelector('link[rel="stylesheet"]')?.getAttribute('href'),
        '../styles.css',
      );
      assert.doesNotMatch(html, /\{\{\w+\}\}|verified-by|data:font/);
    }
    assert.equal(
      new Set([...documents.values()].map((document) => document.title)).size,
      GUIDE_PAGES.length,
    );
    for (const [file, document] of documents) {
      for (const link of document.querySelectorAll('a[href]')) {
        const href = link.getAttribute('href')!;
        if (/^(?:https?:|\.\.\/)/.test(href)) continue;
        const [target, fragment] = href.split('#');
        const destination = documents.get(target || file);
        assert.ok(destination, `${file}: missing ${href}`);
        if (fragment)
          assert.ok(destination.getElementById(fragment), `${file}: missing anchor ${href}`);
      }
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
