import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { Marked } from 'marked';
import { getHeadingList, gfmHeadingId } from 'marked-gfm-heading-id';
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
  const illustrated = new JSDOM(
    renderGuide(
      '# Guide\n\n[![Connection form](../../site/images/guide/connection.png)](../../site/images/guide/connection.png)',
      'index',
    ).content,
  ).window.document;
  assert.equal(
    illustrated.querySelector('img')?.getAttribute('src'),
    '../images/guide/connection.png',
  );
  assert.equal(
    illustrated.querySelector('a')?.getAttribute('href'),
    '../images/guide/connection.png',
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

test('guide alerts keep their label, paragraphs and safe Markdown links', () => {
  const document = new JSDOM(
    renderGuide(
      '# Guide\n\n> [!WARNING]\n> Keep **a backup**.\n>\n> [Help](passwords.md).\n\n> [!NOTE]\n>\n> Read this first.\n\n> An ordinary quotation.',
      'index',
    ).content,
  ).window.document;
  assert.equal(document.querySelector('.guide-warning')?.getAttribute('aria-label'), 'Warning');
  assert.equal(document.querySelector('.guide-warning strong')?.textContent, 'a backup');
  assert.equal(document.querySelector('.guide-warning a')?.getAttribute('href'), 'passwords.html');
  assert.equal(document.querySelector('.guide-warning')?.querySelectorAll('p').length, 3);
  assert.equal(document.querySelector('.guide-note p:last-child')?.textContent, 'Read this first.');
  assert.equal(document.querySelector('blockquote')?.textContent?.trim(), 'An ordinary quotation.');
  assert.throws(() => renderGuide('# Guide\n\n> [!WARNING]\n> [bad](javascript:alert)', 'index'));
});

test('legacy guide links still reach their topic headings', async () => {
  const docs = path.resolve(import.meta.dirname, '../../../docs');
  const legacy = await readFile(path.join(docs, 'user-guide.md'), 'utf8');
  const links = [...legacy.matchAll(/\]\((guide\/[\w-]+\.md)#([^)]*)\)/g)];
  assert.ok(links.length > 0);
  for (const [, target, fragment] of links) {
    new Marked(gfmHeadingId()).parse(await readFile(path.join(docs, target!), 'utf8'));
    assert.ok(
      getHeadingList().some((heading) => heading.id === fragment),
      `${target}#${fragment}`,
    );
  }
});

test('every built guide page has metadata, working navigation and matching sitemap entries', async () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  const out = await mkdtemp(path.join(os.tmpdir(), 'ftpeach-guide-'));
  try {
    await buildGuide(root, out);
    const home = new JSDOM(await readFile(path.join(root, 'site/index.html'), 'utf8')).window
      .document;
    const headerLinks = (document: Document) =>
      [...document.querySelectorAll('.site-header a')].map((link) => ({
        label: link.textContent?.trim(),
        href: link.getAttribute('href'),
      }));
    const expectedHeader = headerLinks(home)
      .filter(({ href }) => !['#how', '#features', '#protocols'].includes(href ?? ''))
      .map(({ label, href }) => ({
        label: label === 'User guide' ? 'Home' : label,
        href:
          href === 'guide/index.html' || href === '#top'
            ? '../index.html'
            : href?.startsWith('#')
              ? `../index.html${href}`
              : href === 'compare.html'
                ? '../compare.html'
                : href,
      }));
    const sitemap = new JSDOM(await readFile(path.join(out, 'sitemap.xml'), 'utf8'), {
      contentType: 'text/xml',
    }).window.document;
    const urls = [...sitemap.querySelectorAll('loc')].map((node) => node.textContent);
    assert.equal(urls.length, GUIDE_PAGES.length + 2);
    assert.ok(urls.includes('https://ftpeach.com/compare.html'));
    const documents = new Map<string, Document>();
    for (const page of GUIDE_PAGES) {
      const html = await readFile(path.join(out, `guide/${page.slug}.html`), 'utf8');
      const document = new JSDOM(html).window.document;
      documents.set(`${page.slug}.html`, document);
      assert.deepEqual(headerLinks(document), expectedHeader);
      assert.ok(document.title.endsWith(' · FTPeach Guide'));
      assert.equal(
        document.querySelector('meta[name="description"]')?.getAttribute('content'),
        page.description,
      );
      assert.ok(
        urls.includes(document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? ''),
      );
      assert.equal(document.querySelectorAll('h1').length, 1);
      const article = document.querySelector('article')!;
      const intro = article.querySelector('p')!;
      const toc = article.querySelector('.guide-toc');
      if (page.slug === 'index') assert.equal(toc, null);
      else {
        assert.ok(toc);
        assert.ok(intro.compareDocumentPosition(toc) & 4, 'Introduction comes before navigation');
      }
      assert.equal(
        document.querySelector('nav[aria-label="User guide"] a[href="index.html"]')?.textContent,
        'Overview',
      );
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
    const legacyReference = await readFile(path.join(root, 'docs/protocol-support.md'), 'utf8');
    const reference = documents.get('protocol-reference.html')!;
    assert.ok(reference);
    for (const match of legacyReference.matchAll(/guide\/protocol-reference\.md#([\w-]+)/g)) {
      assert.ok(match[1]);
      assert.ok(reference.getElementById(match[1]), `Legacy reference: missing ${match[1]}`);
    }
    assert.doesNotMatch(legacyReference, /^\|/m, 'Keep compatibility tables in one document');
    for (const [file, document] of documents) {
      for (const link of document.querySelectorAll('a[href]')) {
        const href = link.getAttribute('href')!;
        if (href.startsWith('../images/guide/')) {
          assert.deepEqual(
            await readFile(path.join(out, 'guide', href)),
            await readFile(path.join(root, 'site/guide', href)),
          );
          continue;
        }
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
