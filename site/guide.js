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
