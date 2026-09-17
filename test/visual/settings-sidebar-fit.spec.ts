import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';

const localesDir = new URL('../../src/i18n/locales/', import.meta.url);
const languages = readdirSync(localesDir)
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.slice(0, -'.json'.length));

// Long translations must not spill out: Greek "Cancel"/"Save" once pushed the
// Save button past the sidebar, and checkbox labels and shortcut names ran
// past the panel edge.
for (const language of languages) {
  test(`settings dialog fits its translations (${language})`, async ({ page }) => {
    const strings = JSON.parse(readFileSync(new URL(`${language}.json`, localesDir), 'utf8')) as {
      menu: { edit: { title: string } };
    };
    await page.goto(`/visual.html?lang=${language}`);
    await expect(page.locator('.pane-list').first()).toBeVisible();
    // The language switch re-renders the menu bar; opening a menu before it
    // lands can lose the click.
    const editMenu = page.locator('.menu-bar-trigger').nth(1);
    await expect(editMenu).toHaveText(strings.menu.edit.title);
    await editMenu.click();
    await page.locator('.menu-dropdown .menu-item').first().click();
    await expect(page.locator('.settings-nav-footer')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    const sidebar = await page.evaluate(() => {
      const footer = document.querySelector('.settings-nav-footer')!.getBoundingClientRect();
      const problems: string[] = [];
      for (const button of document.querySelectorAll<HTMLElement>('.settings-nav-footer .btn')) {
        const box = button.getBoundingClientRect();
        if (box.left < footer.left - 0.5 || box.right > footer.right + 0.5) {
          problems.push(`button "${button.textContent}" leaves the footer`);
        }
        if (button.scrollWidth > button.clientWidth) {
          problems.push(`button "${button.textContent}" clips its label`);
        }
      }
      for (const item of document.querySelectorAll<HTMLElement>('.settings-nav-item')) {
        if (item.scrollWidth > item.clientWidth) {
          problems.push(`category "${item.textContent}" clips its label`);
        }
      }
      return problems;
    });
    expect(sidebar).toEqual([]);

    const categories = page.locator('.settings-nav-item');
    const panels: string[] = [];
    for (let index = 0; index < (await categories.count()); index += 1) {
      await categories.nth(index).click();
      const panel = page.locator('.settings-panel');
      const overflow = await panel.evaluate((element) => element.scrollWidth - element.clientWidth);
      if (overflow > 0)
        panels.push(`"${await categories.nth(index).textContent()}" by ${overflow}px`);
    }
    expect(panels, 'panels overflowing horizontally').toEqual([]);
  });
}
