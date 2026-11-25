import { expect, test } from '@playwright/test';

const PALETTES = [
  ['peach', 'Peach'],
  ['black', 'Onyx'],
  ['gray', 'Ash'],
  ['graphite', 'Graphite'],
  ['linen', 'Linen'],
  ['sand', 'Sand'],
  ['cocoa', 'Cocoa'],
  ['amber', 'Amber'],
  ['clay', 'Clay'],
  ['leaves', 'Grass'],
  ['forest', 'Forest'],
  ['solarized', 'Lagoon'],
  ['nord', 'Frost'],
  ['ocean', 'Ocean'],
  ['midnight', 'Midnight'],
  ['catppuccin', 'Bluebell'],
  ['dracula', 'Orchid'],
  ['plum', 'Plum'],
  ['burgundy', 'Burgundy'],
  ['rose', 'Rose'],
] as const;

// Representative visual frames: default palette + monochrome palette in both modes.
// All 20 palettes are verified via resolved CSS tokens, WCAG contrast, and text snapshot below.
const VISUAL_SNAPSHOT_PALETTES = [
  ['peach', 'Peach'],
  ['black', 'Onyx'],
] as const;

const CONTRAST_CHECKED_SCHEMES = new Set<string>([
  'dracula',
  'catppuccin',
  'nord',
  'solarized',
  'black',
  'gray',
  'sand',
  'rose',
  'leaves',
  'midnight',
  'plum',
  'amber',
  'clay',
  'cocoa',
  'linen',
  'burgundy',
]);

const GREYSCALE_SCHEMES = new Set<string>(['black', 'gray']);

const PALETTE_TOKENS = [
  '--bg-base',
  '--bg-panel',
  '--bg-panel-alt',
  '--bg-raised',
  '--border',
  '--border-soft',
  '--window-border',
  '--text-primary',
  '--text-secondary',
  '--text-faint',
  '--accent-primary',
  '--accent-primary-hover',
  '--accent-primary-active',
  '--accent-fill',
  '--accent-fill-text',
  '--btn-fill',
  '--btn-fill-text',
] as const;

const MONOCHROME_TOKENS = [
  '--bg-base',
  '--bg-panel',
  '--bg-panel-alt',
  '--bg-raised',
  '--border',
  '--border-soft',
  '--text-primary',
  '--text-secondary',
  '--text-faint',
  '--accent-primary',
  '--accent-primary-hover',
  '--accent-primary-active',
  '--accent-fill-text',
] as const;

async function openInterfaceSettings(page: import('@playwright/test').Page) {
  await page.goto('/test/visual/visual.html');
  await page.locator('.view-toolbar-settings').click();
  await page.locator('.settings-nav-item[data-category="interface"]').click();
}

async function selectTheme(page: import('@playwright/test').Page, theme: 'dark' | 'light') {
  await page.getByRole('radio', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true }).click();
}

async function selectScheme(page: import('@playwright/test').Page, label: string) {
  await page.getByRole('button', { name: 'Color scheme', exact: true }).click();
  await page
    .getByRole('listbox', { name: 'Color scheme' })
    .getByRole('option', { name: label })
    .click();
}

async function readResolvedTokens(page: import('@playwright/test').Page) {
  return page.evaluate(
    (tokens) => {
      // The browser resolves the token, whatever form the stylesheet spells it in.
      const probe = document.body.appendChild(document.createElement('span'));
      const resolved: Record<string, string> = {};
      for (const token of tokens) {
        probe.style.color = `var(${token})`;
        resolved[token] = getComputedStyle(probe).color;
      }
      probe.remove();
      return resolved;
    },
    [...PALETTE_TOKENS],
  );
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const rgb = color.match(/[\d.]+/g)!.slice(0, 3);
    const channels = rgb.map((channel) => {
      const value = Number(channel) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

for (const theme of ['dark', 'light'] as const) {
  test(`all palettes apply distinct tokens, contrast, and greyscale in ${theme} mode`, async ({
    page,
  }) => {
    await openInterfaceSettings(page);
    await selectTheme(page, theme);
    await page.getByRole('button', { name: 'Color scheme', exact: true }).click();
    await expect(
      page
        .getByRole('listbox', { name: 'Color scheme' })
        .getByRole('option')
        .locator('.menu-item-label'),
    ).toHaveText(PALETTES.map(([, name]) => name));
    await page.locator('.modal-header').click();

    const seenFingerprints = new Set<string>();
    for (const [scheme, label] of PALETTES) {
      await selectScheme(page, label);
      await expect(page.locator('html')).toHaveAttribute('data-color-scheme', scheme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

      const tokens = await readResolvedTokens(page);
      for (const value of Object.values(tokens)) {
        expect(value).toMatch(/^rgba?\(/);
      }
      const fingerprint = JSON.stringify(tokens);
      expect(
        seenFingerprints.has(fingerprint),
        `${scheme}/${theme} duplicates another palette`,
      ).toBe(false);
      seenFingerprints.add(fingerprint);

      if (CONTRAST_CHECKED_SCHEMES.has(scheme)) {
        const pairs = [
          ['--text-secondary', '--bg-panel'],
          ['--text-secondary', '--bg-panel-alt'],
          ['--accent-fill-text', '--accent-primary'],
        ] as const;
        for (const [fg, bg] of pairs) {
          expect(
            contrastRatio(tokens[fg]!, tokens[bg]!),
            `${scheme}/${theme} ${fg} on ${bg}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }

      if (GREYSCALE_SCHEMES.has(scheme)) {
        // Grey: red, green and blue the same.
        for (const token of MONOCHROME_TOKENS) {
          expect(tokens[token], `${scheme}/${theme} ${token}`).toMatch(/^rgb\((\d+), \1, \1\)$/);
        }
      }
    }

    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'peach');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
}

test('resolved CSS tokens match snapshot across all palettes @snapshot', async ({ page }) => {
  await openInterfaceSettings(page);
  const snapshot: Record<string, Record<string, Record<string, string>>> = {
    dark: {},
    light: {},
  };
  for (const theme of ['dark', 'light'] as const) {
    await selectTheme(page, theme);
    for (const [scheme, label] of PALETTES) {
      await selectScheme(page, label);
      await expect(page.locator('html')).toHaveAttribute('data-color-scheme', scheme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      snapshot[theme]![scheme] = await readResolvedTokens(page);
    }
  }
  expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchSnapshot('palette-tokens.json');
});

for (const theme of ['dark', 'light'] as const) {
  for (const [scheme, label] of VISUAL_SNAPSHOT_PALETTES) {
    test(label + ' palette in ' + theme + ' mode @snapshot', async ({ page }) => {
      await openInterfaceSettings(page);
      await selectTheme(page, theme);
      await selectScheme(page, label);
      await expect(page.locator('html')).toHaveAttribute('data-color-scheme', scheme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.locator('.modal-header').click();
      await expect(page.locator('.modal-settings')).toHaveScreenshot(
        'palette-' + scheme + '-' + theme + '.png',
      );
      if (scheme !== 'peach' || theme !== 'dark') {
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      }
      await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'peach');
    });
  }
}

test('system mode follows OS changes without losing the palette', async ({ page }) => {
  await openInterfaceSettings(page);
  await page.getByRole('radio', { name: 'System', exact: true }).click();
  await selectScheme(page, 'Ocean');
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
    await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'ocean');
  }
});
