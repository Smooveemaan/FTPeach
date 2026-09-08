(async () => {
  const waitFor = (selector, present = true, timeout = 10000) =>
    new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout;
      const poll = () => {
        const element = document.querySelector(selector);
        if (Boolean(element) === present) return resolve(element);
        if (Date.now() >= deadline) return reject(new Error(`timeout waiting for ${selector}`));
        setTimeout(poll, 50);
      };
      poll();
    });
  const waitUntil = (predicate, description, timeout = 10000) =>
    new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout;
      const poll = () => {
        if (predicate()) return resolve();
        if (Date.now() >= deadline) return reject(new Error(`timeout waiting for ${description}`));
        setTimeout(poll, 50);
      };
      poll();
    });
  const key = (keyValue, code, modifiers = {}) =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: keyValue,
        code,
        bubbles: true,
        ...modifiers,
      }),
    );
  const clickByText = (selector, text) => {
    const element = [...document.querySelectorAll(selector)].find(
      (candidate) => candidate.textContent?.trim() === text,
    );
    if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector} named ${text}`);
    element.click();
    return element;
  };
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const parseHex = (value) => {
    const match = value.trim().match(/^#([0-9a-f]{6})$/i);
    if (!match) throw new Error(`expected an opaque hex color, got ${value}`);
    return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16));
  };
  const luminance = (value) => {
    const channels = parseHex(value).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const assertContrast = (foregroundToken, backgroundToken, minimum = 4.5) => {
    const styles = getComputedStyle(document.documentElement);
    const foreground = styles.getPropertyValue(foregroundToken);
    const background = styles.getPropertyValue(backgroundToken);
    const lighter = Math.max(luminance(foreground), luminance(background));
    const darker = Math.min(luminance(foreground), luminance(background));
    const ratio = (lighter + 0.05) / (darker + 0.05);
    if (ratio < minimum)
      throw new Error(
        `${foregroundToken} on ${backgroundToken} contrast ${ratio.toFixed(2)} is below ${minimum}`,
      );
  };
  const assertThemeContrast = async (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    await nextFrame();
    assertContrast('--text-primary', '--bg-base');
    assertContrast('--text-primary', '--bg-panel');
    assertContrast('--text-secondary', '--bg-base');
    assertContrast('--text-secondary', '--bg-panel');
    assertContrast('--accent-fill-text', '--accent-fill');
  };
  const assertRtlLayout = async (languageLabel, languageCode) => {
    const languageTrigger = await waitFor('.language-select-trigger');
    if (!(languageTrigger instanceof HTMLElement))
      throw new Error('language trigger is not clickable');
    languageTrigger.click();
    await waitFor('.language-select-dropdown');
    clickByText('.language-select-dropdown .menu-item', languageLabel);
    await waitUntil(
      () => document.documentElement.lang === languageCode,
      `language to switch to ${languageCode}`,
    );
    if (document.documentElement.dir !== 'rtl')
      throw new Error(`${languageCode} did not switch document direction to rtl`);
    const modal = document.querySelector('.modal-settings');
    const nav = document.querySelector('.settings-nav');
    const panel = document.querySelector('.settings-panel');
    if (
      !(modal instanceof HTMLElement) ||
      !(nav instanceof HTMLElement) ||
      !(panel instanceof HTMLElement)
    )
      throw new Error('settings RTL geometry targets are missing');
    const modalRect = modal.getBoundingClientRect();
    const navRect = nav.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    if (navRect.left <= panelRect.left)
      throw new Error(`${languageCode} settings navigation was not mirrored`);
    for (const [name, rect] of [
      ['navigation', navRect],
      ['panel', panelRect],
    ]) {
      if (rect.left < modalRect.left - 1 || rect.right > modalRect.right + 1)
        throw new Error(`${languageCode} ${name} overflows the settings modal`);
    }
  };

  let result = 'ok';
  try {
    const backendResult = await window.__TAURI_INTERNALS__.invoke('smoke_backend_checks');
    if (backendResult !== 'settings-vault-transfer-ok')
      throw new Error(`unexpected backend smoke result: ${backendResult}`);
    await waitFor('.menu-bar');
    await waitFor('.panes');
    await waitFor('.status-bar');
    key(',', 'Comma', { ctrlKey: true });
    await waitFor('.modal-settings');
    clickByText('.settings-nav-item', 'Interface');
    await waitFor('.language-select-trigger');
    await assertThemeContrast('dark');
    await assertThemeContrast('light');
    await assertRtlLayout('العربية', 'ar');
    await assertRtlLayout('עברית', 'he');
    key('Escape', 'Escape');
    await waitFor('.modal-settings', false);
    const siteButton = await waitFor('.pane-connect-cta');
    if (!(siteButton instanceof HTMLElement))
      throw new Error('site manager button is not clickable');
    siteButton.click();
    await waitFor('.modal-site-manager');
    key('Escape', 'Escape');
    await waitFor('.modal-site-manager', false);
  } catch (error) {
    result = `error: ${error instanceof Error ? error.message : String(error)}`;
  }
  const url = new URL(window.location.href);
  url.searchParams.set('ftpeachSmoke', result);
  window.location.replace(url);
})();
