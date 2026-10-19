import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Marked } from 'marked';
import { getHeadingList, gfmHeadingId } from 'marked-gfm-heading-id';

const repository = 'https://github.com/Smooveemaan/ftpeach/blob/master/';

/** Published pages, in reading order; the Markdown supplies each title. */
export const GUIDE_PAGES = [
  {
    slug: 'index',
    description:
      'Learn to connect to a server, transfer and edit files, manage saved connections and solve common problems in FTPeach.',
  },
  {
    slug: 'getting-started',
    description: 'Prepare your connection details, upload your first file and check the result.',
  },
  {
    slug: 'interface',
    description: 'Find folders, select files, use shortcuts and follow transfers in FTPeach.',
  },
  {
    slug: 'connecting',
    description: 'Choose a protocol, connect with a password or SSH key and save a bookmark.',
  },
  {
    slug: 'ftp',
    description:
      'Connect to FTP in FTPeach, understand passive and active mode and troubleshoot listing and transfer failures.',
  },
  {
    slug: 'ftps',
    description:
      'Set up explicit FTPS in FTPeach, verify TLS certificates, choose a trusted CA and resolve connection errors.',
  },
  {
    slug: 'sftp',
    description:
      'Connect to SFTP with a password or SSH key, verify the server fingerprint and resolve key and login errors in FTPeach.',
  },
  {
    slug: 'webdav',
    description:
      'Set up a WebDAV URL in FTPeach, use HTTPS and account credentials, understand upload limits and resolve connection errors.',
  },
  {
    slug: 'transfers',
    description:
      'Pause, stop and resume FTPeach transfers, recover interrupted downloads, and copy, rename or move files.',
  },
  {
    slug: 'editing',
    description: 'Open server files in another program and recover edited copies in FTPeach.',
  },
  {
    slug: 'portable',
    description:
      'Use the portable copy of FTPeach, carry its settings and passwords, and update it.',
  },
  {
    slug: 'passwords',
    description:
      'Move FTPeach bookmarks and saved passwords between computers, and unlock with Windows Hello.',
  },
  {
    slug: 'troubleshooting',
    description: 'Resolve connection and transfer errors, recover edits and check saved passwords.',
  },
];

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Render repository Markdown with GitHub-compatible anchors and website links. */
export function renderGuide(markdown: string, slug: string) {
  const parser = new Marked(gfmHeadingId(), {
    walkTokens(token) {
      if (token.type !== 'link' && token.type !== 'image') return;
      const href = token.href;
      if (href.startsWith('#')) return;
      const url = new URL(href, `${repository}docs/guide/${slug}.md`);
      if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) {
        throw new Error(`Unsupported guide link: ${href}`);
      }
      if (!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) {
        if (!url.href.startsWith(repository))
          throw new Error(`Link leaves the repository: ${href}`);
        const asset = /^site\/(images\/guide\/[a-z0-9-]+\.png)$/.exec(
          url.pathname.slice(new URL(repository).pathname.length),
        );
        if (asset) {
          token.href = `../${asset[1]}`;
          return;
        }
        const guide = /^docs\/guide\/([^/]+)\.md$/.exec(
          url.pathname.slice(new URL(repository).pathname.length),
        );
        if (guide) {
          if (!GUIDE_PAGES.some((page) => page.slug === guide[1]))
            throw new Error(`Unpublished guide page: ${href}`);
          token.href = `${guide[1]}.html${url.search}${url.hash}`;
          return;
        }
      }
      token.href = url.href;
    },
    renderer: {
      blockquote({ tokens }) {
        const body = this.parser.parse(tokens);
        const alert = /^<p>\[!(NOTE|WARNING)\](?:\n|<\/p>\n)/.exec(body);
        if (!alert) return `<blockquote>\n${body}</blockquote>\n`;
        const kind = alert[1]!.toLowerCase();
        const content = (alert[0].includes('</p>') ? '' : '<p>') + body.slice(alert[0].length);
        return `<aside class="guide-callout guide-${kind}" aria-label="${kind === 'note' ? 'Note' : 'Warning'}"><p class="guide-callout-title">${kind === 'note' ? 'Note' : 'Warning'}</p>${content}</aside>\n`;
      },
      html({ text }) {
        // Verification comments stay in the source, not in the published page.
        if (/^\s*<!--[\s\S]*?-->\s*$/.test(text)) return '';
        throw new Error('Guide Markdown must not contain raw HTML');
      },
    },
  });
  const content = parser.parse(markdown, { async: false });
  const headings = [...getHeadingList()];
  const titles = headings.filter((heading) => heading.level === 1);
  if (titles.length !== 1) throw new Error(`${slug}.md must have exactly one level-one heading`);
  const title = titles[0]!.raw;
  const toc = headings
    .filter((heading) => heading.level === 2)
    .map(
      (heading) => `<li><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.raw)}</a></li>`,
    )
    .join('\n');
  return { title, content, toc };
}

/** Build every guide page and the sitemap from the same page list. */
export async function buildGuide(root: string, out: string): Promise<void> {
  const template = await readFile(path.join(root, 'site/guide.html'), 'utf8');
  const pages = [];
  for (const page of GUIDE_PAGES) {
    const markdown = await readFile(path.join(root, `docs/guide/${page.slug}.md`), 'utf8');
    pages.push({ ...page, ...renderGuide(markdown, page.slug) });
  }
  await mkdir(path.join(out, 'guide'), { recursive: true });
  await cp(path.join(root, 'site/images/guide'), path.join(out, 'images/guide'), {
    recursive: true,
  });
  for (const page of pages) {
    const canonical = `https://ftpeach.com/guide/${page.slug === 'index' ? '' : `${page.slug}.html`}`;
    const navigation = pages
      .map(
        (entry) =>
          `<li><a href="${entry.slug}.html"${entry.slug === page.slug ? ' aria-current="page"' : ''}>${escapeHtml(entry.slug === 'index' ? 'Overview' : entry.title)}</a></li>`,
      )
      .join('\n');
    const toc =
      page.toc && page.slug !== 'index'
        ? `<details class="guide-toc"><summary>On this page</summary><nav aria-label="On this page"><ul>${page.toc}</ul></nav></details>`
        : '';
    const values: Record<string, string> = {
      TITLE: escapeHtml(page.title),
      DESCRIPTION: escapeHtml(page.description),
      CANONICAL: canonical,
      CONTENT: page.content.replace('<h2', () => `${toc}<h2`),
      NAVIGATION: navigation,
      SOURCE: `${repository}docs/guide/${page.slug}.md`,
    };
    const html = template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      if (!(key in values)) throw new Error(`Unknown guide placeholder: ${key}`);
      return values[key]!;
    });
    await writeFile(path.join(out, `guide/${page.slug}.html`), html);
  }
  const urls = [
    'https://ftpeach.com/',
    ...pages.map(
      (page) => `https://ftpeach.com/guide/${page.slug === 'index' ? '' : `${page.slug}.html`}`,
    ),
  ];
  await writeFile(
    path.join(out, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${url}</loc></url>`).join('\n')}\n</urlset>\n`,
  );
}
