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
  guideRoot.dataset.theme = theme;
  try {
    localStorage.setItem('theme', theme);
  } catch {}
  syncGuideTheme();
});
guideSystemDark.addEventListener('change', syncGuideTheme);
syncGuideTheme();
guideToggle.hidden = false;

const imageViewer = document.querySelector('.guide-image-viewer');
const enlargedImage = imageViewer.querySelector('img');
let imageOpener;
for (const link of document.querySelectorAll('.guide-content a:has(> img)')) {
  link.setAttribute('aria-haspopup', 'dialog');
  link.addEventListener('click', (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const thumbnail = link.querySelector('img');
    imageOpener = link;
    enlargedImage.src = link.href;
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
