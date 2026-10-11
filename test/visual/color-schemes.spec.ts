import { expect, test } from '@playwright/test';

const PALETTES = [
  ['peach', 'Peach'],
  ['black', 'Onyx'],
  ['gray', 'Ash'],
  ['graphite', 'Graphite'],
  ['linen', 'Linen'],
  ['sand', 'Sand'],
  ['cocoa', 'Cocoa'],
  ['ember', 'Ember'],
  ['clay', 'Clay'],
  ['leaves', 'Leaves'],
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

for (const theme of ['dark', 'light'] as const) {
  for (const [scheme, label] of PALETTES) {
    test(label + ' palette in ' + theme + ' mode', async ({ page }) => {
      await page.goto('/test/visual/visual.html');
      await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Settings…' }).click();
      await page.getByRole('button', { name: 'Interface', exact: true }).click();
      await page
        .getByRole('radio', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true })
        .click();
      await page.getByRole('button', { name: 'Color scheme', exact: true }).click();
      await expect(
        page
          .getByRole('listbox', { name: 'Color scheme' })
          .getByRole('option')
          .locator('.menu-item-label'),
      ).toHaveText(PALETTES.map(([, name]) => name));
      await page
        .getByRole('listbox', { name: 'Color scheme' })
        .getByRole('option', { name: label })
        .click();
      await expect(page.locator('html')).toHaveAttribute('data-color-scheme', scheme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      if (
        [
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
          'ember',
          'clay',
          'cocoa',
          'linen',
          'burgundy',
        ].includes(scheme)
      ) {
        const contrasts = await page.evaluate(() => {
          const styles = getComputedStyle(document.documentElement);
          const luminance = (token: string) => {
            const hex = styles.getPropertyValue(token).trim().slice(1);
            const channels = [0, 2, 4].map((offset) => {
              const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
              return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            });
            return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
          };
          return [
            ['--text-secondary', '--bg-panel'],
            ['--text-secondary', '--bg-panel-alt'],
            ['--accent-fill-text', '--accent-primary'],
          ].map(([foreground, background]) => {
            const values = [luminance(foreground!), luminance(background!)];
            return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
          });
        });
        for (const contrast of contrasts) expect(contrast).toBeGreaterThanOrEqual(4.5);
      }
      if (['black', 'gray'].includes(scheme)) {
        const colors = await page.evaluate(() => {
          const styles = getComputedStyle(document.documentElement);
          return [
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
          ].map((token) => styles.getPropertyValue(token).trim());
        });
        for (const color of colors) expect(color).toMatch(/^#([0-9a-f]{2})\1\1$/i);
      }
      await page.locator('.modal-header').click();
      await expect(page.locator('.modal-settings')).toHaveScreenshot(
        'palette-' + scheme + '-' + theme + '.png',
      );
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'peach');
    });
  }
}

test('system mode follows OS changes without losing the palette', async ({ page }) => {
  await page.goto('/test/visual/visual.html');
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Settings…' }).click();
  await page.getByRole('button', { name: 'Interface', exact: true }).click();
  await page.getByRole('radio', { name: 'System', exact: true }).click();
  await page.getByRole('button', { name: 'Color scheme', exact: true }).click();
  await page.getByRole('option', { name: 'Ocean', exact: true }).click();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
    await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'ocean');
  }
});
