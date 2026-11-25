import { expect, test } from '@playwright/test';

test('content zoom scales both file panes symmetrically without shifting headers and scales SSH terminal independently', async ({
  page,
}) => {
  await page.goto('/test/visual/visual.html');
  await page.evaluate(() => document.fonts.ready);

  const zoomMod = await page.evaluate(() =>
    /Macintosh|Mac OS X/i.test(navigator.userAgent) ? 'Meta' : 'Control',
  );

  const paneA = page.locator('.pane[data-side="a"]');
  const paneB = page.locator('.pane[data-side="b"]');
  const rowA = paneA.locator('.pane-list .row[data-index="0"]');
  const rowB = paneB.locator('.pane-list .row[data-index="0"]');
  const headerA = paneA.locator('.row-header');
  await expect(rowA).toBeVisible();
  await expect(rowB).toBeVisible();

  const metrics = async () => ({
    rowAHeight: (await rowA.boundingBox())!.height,
    rowBHeight: (await rowB.boundingBox())!.height,
    headerHeight: (await headerA.boundingBox())!.height,
    nameFontSize: await rowA
      .locator('.name')
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize)),
    headerNameLeft: await headerA
      .locator('[data-column-key="name"], .col-header')
      .first()
      .evaluate((el) => el.getBoundingClientRect().left),
    rowNameLeft: await rowA.locator('.name').evaluate((el) => el.getBoundingClientRect().left),
  });

  const baseline = await metrics();
  expect(baseline.rowAHeight).toBeCloseTo(baseline.rowBHeight, 1);
  expect(baseline.headerNameLeft).toBeCloseTo(baseline.rowNameLeft, 1);

  // Keyboard zoom scales both panes equally and keeps header height fixed and aligned.
  await paneA.click();
  await page.keyboard.press(`${zoomMod}+Equal`);
  await page.keyboard.press(`${zoomMod}+Equal`);

  const zoomed = await metrics();
  expect(zoomed.rowAHeight).toBeGreaterThan(baseline.rowAHeight + 2);
  expect(zoomed.rowAHeight).toBeCloseTo(zoomed.rowBHeight, 1);
  expect(zoomed.nameFontSize).toBeCloseTo(baseline.nameFontSize * 1.2, 1);
  expect(zoomed.headerHeight).toBeCloseTo(baseline.headerHeight, 1);
  expect(zoomed.headerNameLeft).toBeCloseTo(zoomed.rowNameLeft, 1);

  // Ctrl+Wheel (Cmd+Wheel on macOS) over the file list steps fileListScale down.
  const listBox = (await paneA.locator('.pane-list').boundingBox())!;
  await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2);
  await page.keyboard.down(zoomMod);
  await page.mouse.wheel(0, 120);
  await page.keyboard.up(zoomMod);

  const steppedDown = await metrics();
  expect(steppedDown.nameFontSize).toBeCloseTo(baseline.nameFontSize * 1.1, 1);

  // Reset zoom returns to baseline.
  await page.keyboard.press(`${zoomMod}+Digit0`);
  const reset = await metrics();
  expect(reset.rowAHeight).toBeCloseTo(baseline.rowAHeight, 1);
  expect(reset.nameFontSize).toBeCloseTo(baseline.nameFontSize, 1);

  // Open SSH terminal and verify independent terminal font zoom via keyboard and wheel.
  await paneB.locator('.terminal-toggle-btn').click();
  const terminalPanel = paneB.locator('.terminal-panel');
  const terminalRows = terminalPanel.locator('.xterm-rows');
  await expect(terminalRows).toBeVisible();

  const terminalFontSize = () =>
    terminalRows.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));

  const baseTermSize = await terminalFontSize();
  await terminalPanel.locator('.terminal-panel-body').click();
  await page.keyboard.press(`${zoomMod}+Equal`);
  await page.keyboard.press(`${zoomMod}+Equal`);

  await expect.poll(terminalFontSize).toBeCloseTo(baseTermSize + 2, 1);
  // File list stayed at 100% while zooming inside the terminal.
  expect((await metrics()).nameFontSize).toBeCloseTo(baseline.nameFontSize, 1);

  // Ctrl+Wheel (Cmd+Wheel on macOS) over the terminal panel scales terminal font size without touching the file list.
  const termBox = (await terminalPanel.locator('.terminal-panel-body').boundingBox())!;
  await page.mouse.move(termBox.x + termBox.width / 2, termBox.y + termBox.height / 2);
  await page.keyboard.down(zoomMod);
  await page.mouse.wheel(0, -120);
  await page.keyboard.up(zoomMod);
  await expect.poll(terminalFontSize).toBeCloseTo(baseTermSize + 3, 1);

  // On platforms with an in-window MenuBar, View menu Zoom Out/Reset still act on the
  // terminal because focus came from the terminal; on macOS, verify keyboard zoom out/reset.
  const viewMenu = page.locator('.menu-bar-trigger[data-menu="view"]');
  if (await viewMenu.isVisible()) {
    await viewMenu.click();
    await page.getByRole('menuitem', { name: /Zoom Out/ }).click();
    await expect.poll(terminalFontSize).toBeCloseTo(baseTermSize + 2, 1);

    await viewMenu.click();
    await page.getByRole('menuitem', { name: /Reset Zoom/ }).click();
    await expect.poll(terminalFontSize).toBeCloseTo(baseTermSize, 1);
  } else {
    await page.keyboard.press(`${zoomMod}+Minus`);
    await expect.poll(terminalFontSize).toBeCloseTo(baseTermSize + 2, 1);

    await page.keyboard.press(`${zoomMod}+Digit0`);
    await expect.poll(terminalFontSize).toBeCloseTo(baseTermSize, 1);
  }
});
