import { expect, test } from '@playwright/test';
import { COLOR_SCHEMES } from '../../src/shared/appearance.ts';

for (const theme of ['dark', 'light'] as const) {
  test('transfer status colors stay readable across palettes in ' + theme, async ({ page }) => {
    await page.goto('/test/visual/visual.html');
    const results = await page.evaluate(
      ({ schemes, theme }) => {
        const root = document.documentElement;
        root.dataset.theme = theme;
        const host = document.createElement('div');
        host.className = 'transfer-item';
        const badge = document.createElement('span');
        const bar = document.createElement('span');
        const status = document.createElement('span');
        host.append(badge, bar, status);
        document.body.append(host);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!;
        const rgba = (color: string) => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data);
        };
        const luminance = (rgb: number[]) =>
          rgb
            .slice(0, 3)
            .map((v) => {
              const c = v / 255;
              return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            })
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
        const rows = [];
        for (const scheme of schemes) {
          root.dataset.colorScheme = scheme;
          for (const background of ['--bg-panel', '--bg-panel-alt', '--bg-raised']) {
            host.style.background = 'var(' + background + ')';
            const base = rgba(getComputedStyle(host).backgroundColor);
            for (const [state, bottom] of [
              ['progress', 'transferring'],
              ['queued', ''],
              ['done', 'connected'],
              ['error', 'error'],
              ['paused', 'paused'],
              ['cancelling', 'paused'],
              ['stopped', ''],
            ] as const) {
              badge.className = 'status-tag ' + state;
              bar.className = 'p-fill status-' + state;
              status.className = 'status-text state-' + bottom;
              const css = getComputedStyle(badge);
              const fg = rgba(css.color);
              const tint = rgba(css.backgroundColor);
              const blended = base.map(
                (v, i) => (tint[i]! * tint[3]!) / 255 + v * (1 - tint[3]! / 255),
              );
              const a = luminance(fg),
                b = luminance(blended);
              rows.push({
                scheme,
                background,
                state,
                color: css.color,
                contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
                barMatches:
                  state === 'error' || getComputedStyle(bar).backgroundColor === css.color,
                bottomMatches: !bottom || getComputedStyle(status).color === css.color,
              });
            }
          }
        }
        host.remove();
        return rows;
      },
      { schemes: COLOR_SCHEMES, theme },
    );
    for (const row of results) {
      expect(row.contrast, JSON.stringify(row)).toBeGreaterThanOrEqual(4.5);
      expect(row.barMatches, JSON.stringify(row)).toBe(true);
      expect(row.bottomMatches, JSON.stringify(row)).toBe(true);
    }
    const colors = results.filter(
      (row) => row.scheme === 'black' && row.background === '--bg-panel',
    );
    expect(
      new Set(
        colors
          .filter((row) => ['progress', 'queued', 'done', 'error', 'paused'].includes(row.state))
          .map((row) => row.color),
      ).size,
    ).toBe(5);
  });
}
