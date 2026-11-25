import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const UTF8_CYRILLIC = '\u043f\u0440\u0438\u0432\u0435\u0442';

async function openTerminal(page: Page, query = ''): Promise<{ remote: Locator; panel: Locator }> {
  await page.goto(`/test/visual/visual.html${query}`);
  const remote = page.locator('.pane[data-side="b"]');
  const toggle = remote.locator('.terminal-toggle-btn');
  await expect(toggle).toBeVisible();
  await toggle.click();
  const panel = remote.locator('.terminal-panel');
  await expect(panel).toBeVisible();
  return { remote, panel };
}

async function runTerminalLine(page: Page, panel: Locator, line: string) {
  await panel.locator('.terminal-panel-body').click();
  await page.keyboard.insertText(line);
  await page.keyboard.press('Enter');
}

async function dragHandle(page: Page, handle: Locator, deltaY: number) {
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + deltaY, { steps: 10 });
  await page.mouse.up();
}

function parseRgb(color: string): [number, number, number] {
  const match = color.match(/[\d.]+/g);
  expect(match, `unexpected color: ${color}`).not.toBeNull();
  return [Number(match![0]), Number(match![1]), Number(match![2])];
}

test('real xterm.js I/O, UTF-8, FitAddon resize, header alignment and smooth divider drag', async ({
  page,
}) => {
  await page.goto('/test/visual/visual.html');
  const remote = page.locator('.pane[data-side="b"]');
  const toggle = remote.locator('.terminal-toggle-btn');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  const inactiveStyles = await toggle.evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, border: s.borderTopColor, color: s.color };
  });

  await toggle.click();
  const panel = remote.locator('.terminal-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-terminal-mode', 'split');
  await expect(toggle).toHaveClass(/\bactive\b/);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  const activeStyles = await toggle.evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, border: s.borderTopColor, color: s.color };
  });
  expect(activeStyles.border).not.toBe(inactiveStyles.border);
  expect(activeStyles.color).not.toBe(inactiveStyles.color);

  // Real @xterm/xterm renders prompt and echoes ASCII + Cyrillic UTF-8.
  const rows = panel.locator('.xterm-rows');
  await expect(rows).toContainText('deploy@sftp:~$');
  await runTerminalLine(page, panel, `echo_${UTF8_CYRILLIC}`);
  await expect(rows).toContainText(`OUT:echo_${UTF8_CYRILLIC}`);

  // Header height matches file-table .row-header height.
  const tableHeaderBox = await remote.locator('.row-header').boundingBox();
  const termHeaderBox = await panel.locator('.terminal-panel-header').boundingBox();
  expect(tableHeaderBox).not.toBeNull();
  expect(termHeaderBox).not.toBeNull();
  expect(Math.abs(termHeaderBox!.height - tableHeaderBox!.height)).toBeLessThanOrEqual(1);

  // Measure real FitAddon dimensions in split vs maximized mode.
  await runTerminalLine(page, panel, 'size');
  await expect(rows).toContainText(/SIZE:\d+x\d+/);
  const splitSizeText = await rows.innerText();
  const splitMatch = splitSizeText.match(/SIZE:(\d+)x(\d+)/);
  expect(splitMatch).not.toBeNull();
  const splitRows = Number(splitMatch![2]);

  // Maximize and verify header aligns with the table header slot and FitAddon grows rows.
  await panel.locator('[data-action="terminal-maximize"]').click();
  await expect(panel).toHaveAttribute('data-terminal-mode', 'maximized');
  const maxHeaderBox = await panel.locator('.terminal-panel-header').boundingBox();
  expect(maxHeaderBox).not.toBeNull();
  expect(Math.abs(maxHeaderBox!.height - tableHeaderBox!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(maxHeaderBox!.y - tableHeaderBox!.y)).toBeLessThanOrEqual(2);

  await runTerminalLine(page, panel, 'size');
  await expect
    .poll(async () => {
      const matches = [...(await rows.innerText()).matchAll(/SIZE:(\d+)x(\d+)/g)];
      const last = matches.at(-1);
      return last ? Number(last[2]) : 0;
    })
    .toBeGreaterThan(splitRows);

  // Top edge stays interactive in maximized mode: dragging down smoothly returns to split.
  const handle = remote.locator('.terminal-resizer');
  await expect(handle).toBeVisible();
  await dragHandle(page, handle, 220);
  await expect(panel).toHaveAttribute('data-terminal-mode', 'split');
  await expect(page.locator('body')).not.toHaveClass(/\bresize-active\b/);

  // Smooth split drag changes panel height without snapping away.
  const beforeSplitHeight = (await panel.boundingBox())!.height;
  await dragHandle(page, handle, -80);
  const afterSplitHeight = (await panel.boundingBox())!.height;
  expect(afterSplitHeight).toBeGreaterThan(beforeSplitHeight + 40);

  // Dragging all the way to the bottom collapses the terminal cleanly.
  await dragHandle(page, handle, 600);
  await expect(panel).toHaveAttribute('data-terminal-mode', 'collapsed');
  await expect(page.locator('body')).not.toHaveClass(/\bresize-active\b/);
});

test('selection enables copy, scrollback survives collapse and tab switch, and theme updates live', async ({
  page,
}) => {
  const { panel } = await openTerminal(page);
  const rows = panel.locator('.xterm-rows');
  await expect(rows).toContainText('deploy@sftp:~$');

  const copyBtn = panel.locator('[data-action="terminal-copy"]');
  await expect(copyBtn).toBeDisabled();

  await runTerminalLine(page, panel, 'flood');
  await expect(rows).toContainText('LINE_60');

  // Context menu Select all drives real xterm onSelectionChange -> enables Copy button.
  await panel.locator('.terminal-panel-body').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Select all', exact: true }).click();
  await expect(copyBtn).toBeEnabled();

  // Collapse and expand preserves terminal buffer.
  await panel.locator('[data-action="terminal-collapse"]').click();
  await expect(panel).toHaveAttribute('data-terminal-mode', 'collapsed');
  await panel.locator('[data-action="terminal-collapse"]').click();
  await expect(panel).toHaveAttribute('data-terminal-mode', 'split');
  await expect(rows).toContainText('LINE_60');

  // Switching to WebDAV tab hides SFTP terminal and disables its toggle; switching back keeps the buffer.
  await page.getByRole('tab', { name: /Staging/ }).click();
  await expect(panel).toBeHidden();
  await expect(page.locator('.pane[data-side="b"] .terminal-toggle-btn')).toBeDisabled();
  await page.getByRole('tab', { name: /Production/ }).click();
  await expect(panel).toBeVisible();
  await expect(rows).toContainText('LINE_60');

  // Live theme switch (Dark -> Light) updates both panel background and real xterm foreground.
  const body = panel.locator('.terminal-panel-body');
  const darkBg = parseRgb(await body.evaluate((el) => getComputedStyle(el).backgroundColor));
  const darkFg = parseRgb(await rows.evaluate((el) => getComputedStyle(el).color));
  expect((darkBg[0] + darkBg[1] + darkBg[2]) / 3).toBeLessThan(80);
  expect((darkFg[0] + darkFg[1] + darkFg[2]) / 3).toBeGreaterThan(150);

  await page.locator('.view-toolbar-settings').click();
  await page.locator('.settings-nav-item[data-category="interface"]').click();
  await page.getByRole('radio', { name: 'Light', exact: true }).click();
  await page.keyboard.press('Escape');

  await expect
    .poll(async () => {
      const bg = parseRgb(await body.evaluate((el) => getComputedStyle(el).backgroundColor));
      return (bg[0] + bg[1] + bg[2]) / 3;
    })
    .toBeGreaterThan(200);
  await expect
    .poll(async () => {
      const fg = parseRgb(await rows.evaluate((el) => getComputedStyle(el).color));
      return (fg[0] + fg[1] + fg[2]) / 3;
    })
    .toBeLessThan(80);
});

test('shellRefused notice and non-zero exit with Reconnect placed left of Copy/Paste', async ({
  page,
}) => {
  // Refused shell shows status without Reconnect button and disables Paste.
  const refused = await openTerminal(page, '?terminal=refused');
  const status = refused.panel.locator('.terminal-panel-status');
  await expect(status).toHaveText('Shell unavailable');
  await expect(refused.panel.locator('[data-action="terminal-reconnect"]')).toHaveCount(0);
  await expect(refused.panel.locator('[data-action="terminal-paste"]')).toBeDisabled();

  // Normal shell -> exit 7 -> non-zero status, Reconnect left of Copy/Paste, then reconnect works.
  const { panel } = await openTerminal(page);
  const rows = panel.locator('.xterm-rows');
  await expect(rows).toContainText('deploy@sftp:~$');

  await runTerminalLine(page, panel, 'exit 7');
  const exitStatus = panel.locator('.terminal-panel-status');
  await expect(exitStatus).toHaveClass(/\bis-exited\b/);
  await expect(exitStatus).toHaveClass(/\bis-nonzero\b/);
  await expect(exitStatus).toContainText('7');

  const reconnectBtn = panel.locator('[data-action="terminal-reconnect"]');
  const copyBtn = panel.locator('[data-action="terminal-copy"]');
  const pasteBtn = panel.locator('[data-action="terminal-paste"]');
  await expect(reconnectBtn).toBeVisible();
  await expect(pasteBtn).toBeDisabled();

  const reconnectBox = (await reconnectBtn.boundingBox())!;
  const copyBox = (await copyBtn.boundingBox())!;
  const pasteBox = (await pasteBtn.boundingBox())!;
  expect(reconnectBox.x).toBeLessThan(copyBox.x);
  expect(copyBox.x).toBeLessThan(pasteBox.x);

  // Reconnect opens a fresh live shell and clears exited status.
  await reconnectBtn.click();
  await expect(panel.locator('[data-action="terminal-reconnect"]')).toHaveCount(0);
  await expect(pasteBtn).toBeEnabled();
  await runTerminalLine(page, panel, 'after-reconnect');
  await expect(rows).toContainText('OUT:after-reconnect');
});

test('moving terminal to opposite pane preserves live session in horizontal, vertical and single-pane layouts', async ({
  page,
}) => {
  const { remote, panel } = await openTerminal(page);
  const left = page.locator('.pane[data-side="a"]');
  const rows = panel.locator('.xterm-rows');
  await expect(rows).toContainText('deploy@sftp:~$');

  await runTerminalLine(page, panel, 'dock-marker');
  await expect(rows).toContainText('OUT:dock-marker');

  const moveRightToLeft = panel.locator('[data-action="terminal-move-pane"]');
  await expect(moveRightToLeft).toHaveAttribute('aria-label', 'Move terminal to pane on the left');
  await moveRightToLeft.click();

  // Terminal now fills pane A without reconnecting; pane B shows its files and keeps toggle active.
  const dockedPanel = left.locator('.terminal-panel');
  await expect(dockedPanel).toBeVisible();
  await expect(dockedPanel).toHaveAttribute('data-terminal-dock', 'other');
  await expect(dockedPanel.locator('.terminal-panel-source')).toBeVisible();
  await expect(dockedPanel.locator('.xterm-rows')).toContainText('OUT:dock-marker');
  await expect(dockedPanel.locator('[data-action="terminal-collapse"]')).toHaveCount(0);
  await expect(dockedPanel.locator('[data-action="terminal-maximize"]')).toHaveCount(0);
  await expect(remote.locator('.terminal-panel')).toHaveCount(0);
  await expect(remote.locator('.terminal-toggle-btn')).toHaveAttribute('aria-pressed', 'true');
  await expect(dockedPanel.locator('[data-action="terminal-move-pane"]')).toHaveAttribute(
    'aria-label',
    'Move terminal to pane on the right',
  );

  // Switch to stacked (vertical) pane layout: move icon/label adapts to top/bottom.
  const orientationToggle = page.locator('.orientation-toggle');
  await orientationToggle.click();
  await expect(dockedPanel.locator('[data-action="terminal-move-pane"]')).toHaveAttribute(
    'aria-label',
    'Move terminal to pane below',
  );

  // Move back to pane B (bottom pane) and verify local pane A restores and buffer survives.
  await dockedPanel.locator('[data-action="terminal-move-pane"]').click();
  await expect(left.locator('.terminal-panel')).toHaveCount(0);
  await expect(left.locator('.pane-list')).toBeVisible();
  await expect(remote.locator('.terminal-panel')).toHaveAttribute('data-terminal-dock', 'same');
  await expect(remote.locator('.terminal-panel .xterm-rows')).toContainText('OUT:dock-marker');
  await expect(remote.locator('[data-action="terminal-move-pane"]')).toHaveAttribute(
    'aria-label',
    'Move terminal to pane above',
  );

  // Return to horizontal layout and hide the left pane: docking still works and opens a temporary slot.
  await orientationToggle.click();
  const leftPaneToggle = page.getByRole('button', { name: 'Show/hide left pane', exact: true });
  await leftPaneToggle.click();
  await expect(left).toHaveCount(0);
  await expect(remote.locator('[data-action="terminal-move-pane"]')).toHaveAttribute(
    'aria-label',
    'Move terminal to pane on the left',
  );

  await remote.locator('[data-action="terminal-move-pane"]').click();
  await expect(left).toHaveCount(1);
  await expect(page.locator('.pane-resizer')).toBeVisible();
  await expect(dockedPanel).toBeVisible();
  await expect(dockedPanel.locator('.xterm-rows')).toContainText('OUT:dock-marker');
  await expect(leftPaneToggle).not.toHaveClass(/\bactive\b/);

  // Moving the terminal back hides the temporary left slot again without losing the session.
  await dockedPanel.locator('[data-action="terminal-move-pane"]').click();
  await expect(left).toHaveCount(0);
  await expect(remote.locator('.terminal-panel')).toHaveAttribute('data-terminal-dock', 'same');
  await expect(remote.locator('.terminal-panel .xterm-rows')).toContainText('OUT:dock-marker');
});
