const guideRoot = document.documentElement;
const guideToggle = document.getElementById('theme-toggle');
const guideSystemDark = matchMedia('(prefers-color-scheme: dark)');
const guideIsDark = () =>
  guideRoot.dataset.theme ? guideRoot.dataset.theme === 'dark' : guideSystemDark.matches;
function syncGuideTheme() {
  const dark = guideIsDark();
  guideToggle.dataset.mode = dark ? 'dark' : 'light';
  guideToggle.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
}
guideToggle.addEventListener('click', () => {
  const theme = guideIsDark() ? 'light' : 'dark';
  switchTheme(() => {
    guideRoot.dataset.theme = theme;
    try {
      localStorage.setItem('theme', theme);
    } catch {}
    syncGuideTheme();
    return Promise.all(
      [...document.querySelectorAll(`.shot-${theme}`)].map((img) => img.decode().catch(() => {})),
    );
  });
});
guideSystemDark.addEventListener('change', syncGuideTheme);
syncGuideTheme();

// The menu on narrow screens: a link, Esc, a tap outside or a wider window closes it.
const guideHeader = document.querySelector('.site-header');
const guideBurger = guideHeader.querySelector('.burger');
const guideMenu = document.getElementById('menu');
const showGuideMenu = (on) => {
  guideBurger.setAttribute('aria-expanded', String(on));
  guideMenu.hidden = !on;
};
guideBurger.hidden = false;
guideBurger.addEventListener('click', () => showGuideMenu(guideMenu.hidden));
guideMenu.addEventListener('click', (event) => event.target.closest('a') && showGuideMenu(false));
addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || guideMenu.hidden) return;
  showGuideMenu(false);
  guideBurger.focus();
});
document.addEventListener('click', (event) => {
  if (!guideMenu.hidden && !guideHeader.contains(event.target)) showGuideMenu(false);
});
matchMedia('(min-width: 1041px)').addEventListener('change', (event) => {
  if (event.matches) showGuideMenu(false);
});
// The header's edge shows once the page moves under it.
const markGuideHeader = () => guideHeader.classList.toggle('stuck', scrollY > 0);
addEventListener('scroll', markGuideHeader, { passive: true });
markGuideHeader();

const guideWideScreen = matchMedia('(min-width: 901px)');
function syncGuideNavigation() {
  for (const menu of document.querySelectorAll('.guide-chapters, .guide-toc'))
    menu.open = guideWideScreen.matches;
}
guideWideScreen.addEventListener('change', syncGuideNavigation);
syncGuideNavigation();
requestAnimationFrame(() => requestAnimationFrame(() => guideRoot.classList.add('settled')));

const imageViewer = document.querySelector('.guide-image-viewer');
if (imageViewer) {
  const enlargedImage = imageViewer.querySelector('img');
  let imageOpener;
  for (const link of document.querySelectorAll('.guide-content a:has(> img)')) {
    link.setAttribute('aria-haspopup', 'dialog');
    link.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      // The screenshot in the theme being read, not always the dark one the link points to.
      const thumbnail =
        [...link.querySelectorAll('img')].find((img) => img.offsetParent) ??
        link.querySelector('img');
      imageOpener = link;
      enlargedImage.src = thumbnail.classList.contains('shot-light') ? thumbnail.src : link.href;
      enlargedImage.alt = thumbnail.alt;
      enlargedImage.style.width = `${Math.max(thumbnail.naturalWidth, thumbnail.width * 2)}px`;
      imageViewer.showModal();
      imageViewer.querySelector('.guide-image-stage').scrollTo(0, 0);
      guideRoot.classList.add('guide-image-open');
    });
  }
  imageViewer.querySelector('button').addEventListener('click', () => imageViewer.close());
  imageViewer.addEventListener('click', (event) => {
    if (event.target === imageViewer) imageViewer.close();
  });
  imageViewer.addEventListener('close', () => {
    guideRoot.classList.remove('guide-image-open');
    imageOpener?.focus({ preventScroll: true });
  });
}

// After a reload, back to the same place exactly, once the chapters and contents are folded or open.
// Text set in a font that arrives later can reflow above; then the place is set again, unless the
// reader has scrolled in the meantime.
try {
  addEventListener('pagehide', () => sessionStorage.setItem('scroll', String(scrollY)));
  const savedScroll = sessionStorage.getItem('scroll');
  if (savedScroll !== null && performance.getEntriesByType('navigation')[0]?.type === 'reload') {
    const restore = () => scrollTo({ top: Number(savedScroll), behavior: 'instant' });
    restore();
    let moved = false;
    const markMoved = () => (moved = true);
    for (const type of ['wheel', 'touchmove', 'keydown'])
      addEventListener(type, markMoved, { once: true, passive: true });
    document.fonts.ready.then(() => moved || restore());
  }
} catch {}
