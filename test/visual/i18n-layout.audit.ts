/**
 * Opens every screen, menu and dialog the harness can reach in every language
 * and in the pseudo-locale, and records where the layout fails the text.
 * `npm run i18n:audit`; findings land in test-results/i18n-audit (see
 * i18nAuditSummary.ts). The run itself passes: it is a report, not a gate.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { auditLayout } from './layoutAudit.ts';
import type { LayoutProblem } from './layoutAudit.ts';
import { PSEUDO_CLOSE, PSEUDO_OPEN, pseudoLocalize } from './pseudoLocale.ts';
import { PROMPTS } from './securityConfirmationHarness.ts';

type Strings = { [key: string]: string | Strings };

const localesDir = new URL('../../src/i18n/locales/', import.meta.url);
const load = (language: string): Strings =>
  JSON.parse(readFileSync(new URL(`${language}.json`, localesDir), 'utf8')) as Strings;
const en = load('en');
const allKeys: string[] = [];
(function collect(node: Strings, prefix: string) {
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') allKeys.push(prefix + key);
    else collect(value, `${prefix}${key}.`);
  }
})(en, '');

const only = process.env.I18N_AUDIT_LANGS?.split(',').filter(Boolean);
const languages = [
  'pseudo',
  ...readdirSync(localesDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length)),
].filter((language) => !only || only.includes(language));

/** Text that is data, not interface: fixture names, hosts and paths anywhere in
 * a string, and whole strings that are shortcuts, drives or proper names.
 * Regular expression sources, since they cross into the page. */
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FIXTURE_DATA = [
  ...[
    'Production',
    'Staging',
    'Archive',
    'example.com',
    'Projects',
    'Downloads',
    'release-notes.md',
    'ftpeach-backup.zip',
    'public_html',
    'index.html',
    'robots.txt',
    'quarterly-infrastructure',
    'C:\\Users',
    '/var/www',
    '.bin',
    'Leonid Lozovskii',
    'Windows (C:)',
    'SHA256:',
    'Notepad++',
    'deploy.cmd',
    'notes.txt',
    'USER deploy',
    '331 Password required',
  ].map(escape),
  String.raw`^(?:(?:Ctrl|Shift|Alt|Meta)\+)*(?:F\d{1,2}|Backspace|Escape|Enter|Delete|Del|Tab|Space|Home|End|PageUp|PageDown|Insert|[A-Z0-9,.;/=←→↑↓-])$`,
  String.raw`^v\d+\.\d+\.\d+`,
  String.raw`^(?:FTPeach|FTP|FTPS|SFTP|WebDAV|GitHub|Ko-fi|MIT|Apache-2\.0|UTC|each|v|[A-Z]:\\?|Users|var|www|developer|backups|deploy|editor|archivist|UTF-8|RESET)$`,
  // The language picker shows each language by its own name; this one is Russian.
  String.raw`^\u0420\u0443\u0441\u0441\u043a\u0438\u0439$`,
];

interface Audit {
  page: Page;
  /** The current language's text for an i18n key (English where it has none). */
  t: (_key: string) => string;
  snap: (_name: string) => Promise<void>;
}

function translator(language: string) {
  const strings = language === 'pseudo' ? pseudoLocalize(en) : load(language);
  const english = language === 'pseudo' ? strings : en;
  const lookup = (node: Strings, key: string) =>
    key
      .split('.')
      .reduce<Strings | string | undefined>(
        (at, part) => (typeof at === 'object' ? at[part] : undefined),
        node,
      );
  return (key: string) => {
    const value = lookup(strings, key) ?? lookup(english, key);
    if (typeof value !== 'string') throw new Error(`No string for ${key}`);
    return value;
  };
}

async function open(page: Page, language: string, search = '') {
  const params = new URLSearchParams(search);
  params.set('lang', language);
  await page.goto(`/test/visual/visual.html?${params}`);
  await expect(page.locator('.pane-list').first()).toBeVisible();
  const first = page.locator('.menu-bar-trigger').first();
  if (language === 'pseudo') await expect(first).toContainText(PSEUDO_OPEN);
  else await expect(page.locator('html')).toHaveAttribute('lang', language);
  await expect(first).toHaveText(translator(language)('menu.file.title'));
  await page.evaluate(() => document.fonts.ready);
}

/** The security confirmation opens at 460×170 and then sizes itself to its
 * content, width first and height second; the page takes the final size. */
async function openSecurity(page: Page, language: string, prompt: string) {
  await page.setViewportSize({ width: 460, height: 170 });
  let resizes = 0;
  await page.exposeFunction('visualSetSize', async (size: { width: number; height: number }) => {
    await page.setViewportSize({ width: Math.round(size.width), height: Math.round(size.height) });
    resizes += 1;
  });
  await page.goto(
    `/test/visual/visual.html?${new URLSearchParams({ lang: language, security: prompt })}`,
  );
  await expect.poll(() => resizes).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => document.fonts.ready);
}

const menu = async (page: Page, index: number) => {
  await page.locator('.menu-bar-trigger').nth(index).click();
  await expect(page.locator('.menu-dropdown')).toBeVisible();
};
const menuItem = async (page: Page, menuIndex: number, itemIndex: number) => {
  await menu(page, menuIndex);
  await page.locator('.menu-dropdown .menu-item').nth(itemIndex).click();
};
const dialog = (page: Page) => page.locator('[role="dialog"], [role="alertdialog"]').last();
const contextMenu = async (page: Page, target: ReturnType<Page['locator']>) => {
  await target.click({ button: 'right' });
  await expect(page.locator('.context-menu')).toBeVisible();
};

const ROW = '.pane-list .row:not(.row-header)';
const MENU = { file: 0, edit: 1, view: 2, transfer: 3, bookmarks: 4, help: 5 };

/** Every screen worth a look. Each takes one or more snapshots. */
const SCREENS: Record<
  string,
  {
    search?: string;
    viewport?: [number, number];
    /** Opens the security confirmation window with this prompt instead of the app. */
    security?: keyof typeof PROMPTS;
    run: (_audit: Audit) => Promise<void>;
  }
> = {
  workspace: { run: ({ snap }) => snap('workspace') },
  'workspace-narrow': { viewport: [900, 720], run: ({ snap }) => snap('workspace-narrow') },
  'workspace-min': {
    viewport: [480, 520],
    run: async ({ page, snap }) => {
      await snap('workspace-min');
      const more = page.locator('.toolbar-overflow-anchor button').first();
      if (await more.isVisible()) {
        await more.click();
        await snap('workspace-min/toolbar-overflow');
      }
    },
  },
  'workspace-log': {
    viewport: [1180, 740],
    run: async ({ page, t, snap }) => {
      await page
        .locator(`[data-tooltip="${t('viewToolbar.toggleLog')}"]`)
        .first()
        .click();
      await expect(page.locator('.log-panel-header')).toBeVisible();
      await snap('workspace-log');
    },
  },
  'transfer-statuses': {
    run: async ({ page, snap }) => {
      await page.evaluate(async () => {
        const path = '/src/features/transfers/transferStore.ts';
        const store = await import(/* @vite-ignore */ path);
        const base = {
          direction: 'down',
          protocol: 'sftp',
          connectionId: 'visual-remote',
          bytes: 10,
          total: 100,
        };
        store.setTransfersStore(
          Object.fromEntries(
            (['progress', 'paused', 'error', 'queued', 'done', 'cancelled'] as const).map(
              (status, index) => [
                status,
                {
                  ...base,
                  id: status,
                  name: `${status}.bin`,
                  remoteFile: `/${status}.bin`,
                  localTarget: `C:/${status}.bin`,
                  status,
                  error: status === 'error' ? 'Connection lost' : undefined,
                  startedAt: index,
                },
              ],
            ),
          ),
        );
      });
      await expect(page.locator('.transfer-item').first()).toBeVisible();
      await snap('transfer-statuses');
      await contextMenu(page, page.locator('.transfer-col-header'));
      await snap('transfer-statuses/columns-menu');
    },
  },
  menus: {
    run: async ({ page, snap }) => {
      for (const [name, index] of Object.entries(MENU)) {
        await menu(page, index);
        await snap(`menu/${name}`);
        await page.keyboard.press('Escape');
      }
    },
  },
  'context-menus': {
    run: async ({ page, snap }) => {
      const panes = page.locator('.pane');
      for (const [side, pane] of [
        ['local', panes.nth(0)],
        ['remote', panes.nth(1)],
      ] as const) {
        await contextMenu(page, pane.locator(ROW).nth(2));
        await snap(`context/${side}-file`);
        await page.keyboard.press('Escape');
        await contextMenu(page, pane.locator(ROW).first());
        await snap(`context/${side}-folder`);
        await page.keyboard.press('Escape');
        await contextMenu(page, pane.locator('.pane-list').first());
        await snap(`context/${side}-empty`);
        await page.keyboard.press('Escape');
        await contextMenu(page, pane.locator('.row-header'));
        await snap(`context/${side}-columns`);
        await page.keyboard.press('Escape');
      }
      // Right-clicking a tab renames it.
      await page.locator('[role="tab"]').first().click({ button: 'right' });
      await expect(page.locator('.tab-strip-rename-input')).toBeVisible();
      await snap('tab-rename');
    },
  },
  'pane-source': {
    run: async ({ page, snap }) => {
      await page.locator('.pane-source-anchor button').first().click();
      await expect(page.locator('.pane-source-menu')).toBeVisible();
      await snap('pane-source-menu');
    },
  },
  'connect-bar': {
    run: async ({ page, snap }) => {
      await menuItem(page, MENU.file, 5);
      const pane = page.locator('.pane').nth(1);
      await expect(page.locator('.pane-quicklist-row').first()).toBeVisible();
      await snap('connect/empty-state');
      const protocol = pane.locator('.protocol-select-trigger');
      for (let index = 0; index < 4; index += 1) {
        await protocol.click();
        if (index === 0) await snap('connect/protocol-list');
        await page.locator('.protocol-select-dropdown [role="option"]').nth(index).click();
        await snap(`connect/protocol-${index}`);
      }
    },
  },
  settings: {
    run: async ({ page, snap }) => {
      await menuItem(page, MENU.edit, 0);
      const sections = page.locator('.settings-nav-item');
      await expect(sections.first()).toBeVisible();
      for (let index = 0; index < (await sections.count()); index += 1) {
        await sections.nth(index).click();
        await snap(`settings/${index}`);
      }
    },
  },
  'settings-unsaved': {
    run: async ({ page, snap }) => {
      await menuItem(page, MENU.edit, 0);
      await page.locator('.settings-nav-item').nth(2).click();
      await dialog(page).locator('input[type="checkbox"]').first().click();
      await dialog(page).locator('.modal-close').click();
      await expect(page.locator('[role="dialog"], [role="alertdialog"]')).toHaveCount(2);
      await snap('settings-unsaved');
    },
  },
  search: {
    run: async ({ page, t, snap }) => {
      await page
        .locator(
          `button[data-tooltip="${t('filePane.searchTooltip').replace('{{shortcut}}', 'Ctrl+F')}"]`,
        )
        .first()
        .click();
      await snap('search');
    },
  },
  'settings-transfer': {
    run: async ({ page, snap }) => {
      await menuItem(page, MENU.file, 6);
      await expect(dialog(page)).toBeVisible();
      await snap('export-settings');
      await page.keyboard.press('Escape');
      await menuItem(page, MENU.file, 7);
      await expect(dialog(page)).toBeVisible();
      await snap('import-settings');
    },
  },
  quit: {
    run: async ({ page, snap }) => {
      await menuItem(page, MENU.file, 8);
      await expect(dialog(page)).toBeVisible();
      await snap('quit');
    },
  },
  'reset-layout': {
    run: async ({ page, snap }) => {
      await menuItem(page, MENU.edit, 1);
      await expect(dialog(page)).toBeVisible();
      await snap('reset-layout');
    },
  },
  about: {
    run: async ({ page, snap }) => {
      await menuItem(page, MENU.help, 4);
      await expect(dialog(page)).toBeVisible();
      await snap('about');
    },
  },
  'site-manager': {
    run: async ({ page, t, snap }) => {
      await menuItem(page, MENU.bookmarks, 0);
      await expect(dialog(page)).toBeVisible();
      await snap('sites/list');
      const sort = page.locator('.site-manage-sort-trigger');
      await sort.click();
      await snap('sites/sort');
      await sort.click();
      const row = dialog(page).locator('.site-manage-row').first();
      await row.hover();
      await row.getByRole('button', { name: t('siteManagerDialog.titleEdit') }).click();
      await snap('sites/edit');
      await dialog(page)
        .getByRole('button', { name: t('common.cancel'), exact: true })
        .click();
      await dialog(page)
        .getByRole('button', { name: t('siteManagerDialog.addBookmark') })
        .click();
      const protocol = dialog(page).locator('.protocol-select-trigger');
      for (let index = 0; index < 4; index += 1) {
        await protocol.click();
        await page.locator('.protocol-select-dropdown [role="option"]').nth(index).click();
        await snap(`sites/new-protocol-${index}`);
      }
      await dialog(page)
        .getByRole('button', { name: t('siteManagerDialog.fields.icon'), exact: true })
        .click();
      await snap('sites/icon-picker');
    },
  },
  'site-manager-context': {
    run: async ({ page, snap }) => {
      await menuItem(page, MENU.bookmarks, 0);
      await contextMenu(page, dialog(page).locator('.site-manage-row').first());
      await snap('sites/context-menu');
    },
  },
  'local-paths': {
    run: async ({ page, snap }) => {
      await menuItem(page, MENU.bookmarks, 1);
      await expect(dialog(page)).toBeVisible();
      await snap('local-paths/list');
    },
  },
  prompts: {
    run: async ({ page, t, snap }) => {
      const remote = page.locator('.pane').nth(1);
      const item = (key: string) =>
        page.locator('.context-menu .menu-item-label').getByText(t(key), { exact: true });
      for (const [name, key] of [
        ['new-folder', 'paneMenu.newFolder'],
        ['new-file', 'paneMenu.newFile'],
      ] as const) {
        await contextMenu(page, remote.locator('.pane-list').first());
        await item(key).click();
        await expect(dialog(page)).toBeVisible();
        await snap(`prompt/${name}`);
        await page.keyboard.press('Escape');
      }
      for (const [name, key] of [
        ['permissions', 'paneMenu.permissions'],
        ['move-to', 'paneMenu.moveTo'],
        ['delete', 'paneMenu.delete'],
        ['open-with', 'paneMenu.openWith'],
      ] as const) {
        await contextMenu(page, remote.locator(ROW).nth(2));
        await item(key).click();
        await expect(dialog(page)).toBeVisible();
        await snap(`prompt/${name}`);
        await page.keyboard.press('Escape');
        await expect(dialog(page)).toHaveCount(0);
      }
    },
  },
  log: {
    search: 'log=1',
    viewport: [1180, 740],
    run: async ({ page, t, snap }) => {
      await page
        .locator(`[data-tooltip="${t('viewToolbar.toggleLog')}"]`)
        .first()
        .click();
      await expect(page.locator('.log-line:not([aria-hidden])').first()).toBeVisible();
      await snap('log');
    },
  },
  'recovered-edits': {
    search: 'recoveredEdits=1',
    run: async ({ page, snap }) => {
      await expect(dialog(page)).toBeVisible();
      await snap('recovered-edits');
    },
  },
  'vault-unlock': {
    run: async ({ page, t, snap }) => {
      // Saving needs the vault; a locked one asks for it to be unlocked first.
      // Without Windows Hello: it would unlock at once, the save would be
      // refused again and the retries would never stop.
      await page.evaluate(() => {
        window.api.sites.save = async () => ({
          ok: false,
          errorCode: 'vaultLocked',
          error: 'vault is locked',
        });
        const status = window.api.vault.status;
        window.api.vault.status = async () => ({
          ...(await status()),
          systemUnlockEnabled: false,
        });
      });
      await menuItem(page, MENU.bookmarks, 0);
      const row = dialog(page).locator('.site-manage-row').first();
      await row.hover();
      await row.getByRole('button', { name: t('siteManagerDialog.titleEdit') }).click();
      await dialog(page)
        .getByRole('button', { name: t('common.save'), exact: true })
        .click();
      await expect(page.locator('.modal-vault-unlock')).toBeVisible();
      await snap('vault-unlock');
    },
  },
  'drag-menu': {
    run: async ({ page, snap }) => {
      // Dropping with the right button asks whether to copy or move.
      const from = (await page.locator('.pane').first().locator(ROW).nth(2).boundingBox())!;
      const to = (await page.locator('.pane').nth(1).locator('.pane-list').boundingBox())!;
      await page.mouse.move(from.x + 40, from.y + from.height / 2);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
      await page.mouse.up({ button: 'right' });
      await expect(page.locator('.context-menu')).toBeVisible();
      await snap('drag-menu');
    },
  },
  ...Object.fromEntries(
    (Object.keys(PROMPTS) as (keyof typeof PROMPTS)[]).map((prompt) => [
      `security-${prompt}`,
      { security: prompt, run: ({ snap }: Audit) => snap(`security/${prompt}`) },
    ]),
  ),
  'update-available': { search: 'update=available', run: ({ snap }) => snap('update/available') },
  'update-downloading': {
    search: 'update=downloading&percent=42',
    run: ({ snap }) => snap('update/downloading'),
  },
  'update-downloaded': {
    search: 'update=downloaded',
    run: ({ snap }) => snap('update/downloaded'),
  },
  'quit-requested': {
    search: 'tray=quitRequested',
    run: async ({ page, snap }) => {
      await expect(dialog(page)).toBeVisible();
      await snap('quit-requested');
    },
  },
};

const outDir = new URL('../../test-results/i18n-audit/findings/', import.meta.url);

for (const language of languages) {
  test.describe(language, () => {
    for (const [screen, { search, viewport, security, run }] of Object.entries(SCREENS)) {
      test(screen, async ({ page }) => {
        if (viewport) await page.setViewportSize({ width: viewport[0], height: viewport[1] });
        if (security) await openSecurity(page, language, security);
        else await open(page, language, search);
        const t = translator(language);
        const dir = new URL(`${language}/`, outDir);
        mkdirSync(dir, { recursive: true });
        const snap = async (name: string) => {
          // Let menus, dialogs and fonts settle before measuring.
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          await page.waitForTimeout(150);
          const problems: LayoutProblem[] = await page.evaluate(auditLayout, {
            keys: allKeys,
            pseudo: language === 'pseudo' ? { open: PSEUDO_OPEN, close: PSEUDO_CLOSE } : null,
            data: FIXTURE_DATA,
          });
          const file = name.replace(/\//g, '__');
          writeFileSync(
            new URL(`${file}.json`, dir),
            JSON.stringify(
              { language, state: name, viewport: page.viewportSize(), problems },
              null,
              2,
            ),
          );
          if (problems.length === 0) return;
          // Outline each problem on the screenshot so it can be found at a glance.
          await page.evaluate(
            (rects) => {
              for (const { x, y, width, height } of rects) {
                const mark = document.createElement('div');
                mark.className = 'i18n-audit-mark';
                mark.style.cssText = `position:fixed;left:${x - 2}px;top:${y - 2}px;width:${width + 4}px;height:${height + 4}px;outline:2px solid #ff00aa;z-index:2147483647;pointer-events:none`;
                document.body.append(mark);
              }
            },
            problems.map((problem) => problem.rect),
          );
          await page.screenshot({ path: fileURLToPath(new URL(`${file}.png`, dir)) });
          await page.evaluate(() =>
            document.querySelectorAll('.i18n-audit-mark').forEach((mark) => mark.remove()),
          );
        };
        await run({ page, t, snap });
      });
    }
  });
}
