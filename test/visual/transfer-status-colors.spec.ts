import { expect, test } from '@playwright/test';
import { COLOR_SCHEMES } from '../../src/shared/appearance.ts';

for (const theme of ['dark', 'light'] as const) {
  test.describe(theme, () => {
    test('transfer status colors stay readable across palettes', async ({ page }) => {
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
          const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          const reference = document.createElement('span');
          const track = document.createElement('div');
          track.className = 'p-track';
          host.append(badge, bar, status, icon, reference, track);
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
                ['cancelling', ''],
                ['stopped', ''],
              ] as const) {
                badge.className = 'status-tag ' + state;
                bar.className = 'p-fill status-' + state;
                status.className = 'status-text state-' + bottom;
                icon.setAttribute('class', 'line-pulse state-' + bottom);
                const css = getComputedStyle(badge);
                const fg = rgba(css.color);
                const tint = rgba(css.backgroundColor);
                const blended = base.map(
                  (v, i) => (tint[i]! * tint[3]!) / 255 + v * (1 - tint[3]! / 255),
                );
                const semantic = (
                  {
                    progress: 'active',
                    queued: 'neutral',
                    done: 'success',
                    error: 'error',
                    paused: 'warning',
                    cancelling: 'cancelling',
                    stopped: 'neutral',
                  } as const
                )[state];
                reference.style.color = 'var(--status-' + semantic + '-fill)';
                const barCss = getComputedStyle(bar);
                const edge = rgba(
                  barCss.boxShadow === 'none' ? barCss.backgroundColor : barCss.color,
                );
                const rail = rgba(getComputedStyle(track).backgroundColor);
                const edgeL = luminance(edge),
                  railL = luminance(rail);
                const a = luminance(fg),
                  b = luminance(blended);
                rows.push({
                  scheme,
                  background,
                  state,
                  color: css.color,
                  contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
                  barShadow: barCss.boxShadow,
                  barMatches:
                    state === 'error' ||
                    barCss.backgroundColor === getComputedStyle(reference).color,
                  barContrast:
                    state === 'error'
                      ? 3
                      : (Math.max(edgeL, railL) + 0.05) / (Math.min(edgeL, railL) + 0.05),
                  bottomMatches: !bottom || getComputedStyle(status).color === css.color,
                  iconMatches:
                    !bottom || getComputedStyle(icon).color === getComputedStyle(status).color,
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
        const restored = {
          progress: { dark: 'rgb(255, 157, 114)', light: 'rgb(232, 120, 82)' },
          paused: { dark: 'rgb(255, 201, 143)', light: 'rgb(184, 134, 11)' },
          error: { dark: 'rgb(255, 117, 101)', light: 'rgb(217, 93, 81)' },
        };
        if (row.state === 'error' || row.state === 'progress' || row.state === 'paused') {
          expect(row.color).toBe(restored[row.state][theme]);
        } else {
          expect(row.contrast, JSON.stringify(row)).toBeGreaterThanOrEqual(4.5);
        }
        expect(row.barMatches, JSON.stringify(row)).toBe(true);
        expect(row.barShadow, JSON.stringify(row)).toBe('none');
        if (theme === 'dark')
          expect(row.barContrast, JSON.stringify(row)).toBeGreaterThanOrEqual(3);
        expect(row.bottomMatches, JSON.stringify(row)).toBe(true);
        expect(row.iconMatches, JSON.stringify(row)).toBe(true);
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
      expect(colors.find((row) => row.state === 'cancelling')!.color).toBe(
        colors.find((row) => row.state === 'queued')!.color,
      );
    });
  });
}

test('connection indicators and auxiliary progress share semantic colors across palettes', async ({
  page,
}) => {
  await page.goto('/test/visual/visual.html');
  const failures = await page.evaluate((schemes) => {
    const failures: string[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const reference = document.createElement('span');
    const target = document.createElement('span');
    host.append(reference, target);
    for (const theme of ['dark', 'light'])
      for (const scheme of schemes) {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.colorScheme = scheme;
        for (const [classes, property, token] of [
          ['status-text state-connecting', 'color', '--status-warning'],
          ['line-pulse state-connecting', 'color', '--status-warning'],
          ['tab-strip-dot connecting', 'backgroundColor', '--status-warning-fill'],
          ['pane-source-dot state-connecting', 'backgroundColor', '--status-warning-fill'],
          ['tab-strip-dot connected', 'backgroundColor', '--status-success-fill'],
          ['pane-source-dot state-connected', 'backgroundColor', '--status-success-fill'],
          ['tab-strip-dot error', 'backgroundColor', '--status-error-fill'],
          ['pane-source-dot state-error', 'backgroundColor', '--status-error-fill'],
          ['pane-source-dot state-idle', 'backgroundColor', '--status-error-fill'],
          ['tab-strip-dot', 'backgroundColor', '--text-faint'],
          ['connect-toggle-btn state-idle', 'color', '--status-error'],
          ['connect-toggle-btn state-connecting', 'color', '--status-warning'],
          ['connect-toggle-btn state-connected', 'color', '--status-success'],
          ['log-line-command', 'color', '--log-command'],
          ['log-line-response', 'color', '--log-response'],
          ['log-line-error', 'color', '--log-error'],
          ['openwith-progress-fill', 'backgroundColor', '--status-active-fill'],
          ['dir-icon dir-up', 'color', '--text-secondary'],
          ['dir-icon dir-down', 'color', '--text-secondary'],
          ['dir-icon dir-copy', 'color', '--text-secondary'],
        ] as const) {
          target.className = classes;
          reference.style.color = `var(${token})`;
          // Disable color transitions so this measures the settled state.
          target.style.transition = 'none';
          if (getComputedStyle(target)[property] !== getComputedStyle(reference).color)
            failures.push(`${theme}/${scheme}: ${classes}`);
          if (property === 'backgroundColor' && getComputedStyle(target).boxShadow !== 'none')
            failures.push(`${theme}/${scheme}: ${classes} has an outline`);
        }
        target.className = 'line-pulse';
        if (Number(getComputedStyle(target).opacity) !== 0.3)
          failures.push(`${theme}/${scheme}: cable opacity`);
        target.className = 'p-track';
        if (getComputedStyle(target).height !== '4px')
          failures.push(`${theme}/${scheme}: thin progress`);
      }
    host.remove();
    return failures;
  }, COLOR_SCHEMES);
  expect(failures).toEqual([]);
});
