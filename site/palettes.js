/* exported syncPaletteTheme */
/* global document, matchMedia, Image, IntersectionObserver */
const gallery = document.getElementById('themes');
const preview = gallery.querySelector('.palette-preview');
const options = JSON.parse(gallery.querySelector('#palette-data').textContent);
const modes = [...gallery.querySelectorAll('[data-mode]')];
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
let palette = 'peach';
let revision = 0;
let visible = false;
const currentMode = () =>
  document.documentElement.dataset.theme ?? (systemTheme.matches ? 'dark' : 'light');

async function showPalette(animate = true) {
  if (!visible) return;
  const request = ++revision;
  const selected = options.find((button) => button.id === palette);
  const appearance = currentMode();
  const next = new Image();
  next.src = `palettes/${palette}-${appearance}.webp`;
  next.alt = `FTPeach in ${selected.name}, ${appearance} mode`;
  gallery.querySelector('.palette-error').hidden = true;
  try {
    await next.decode();
  } catch {
    if (request === revision) gallery.querySelector('.palette-error').hidden = false;
    return;
  }
  // A slower earlier request must never replace the visitor's latest choice.
  if (request !== revision) return;
  const previous = preview.lastElementChild;
  preview.append(next);
  for (const button of modes)
    button.setAttribute('aria-pressed', String(button.dataset.mode === appearance));
  gallery.querySelector('#palette-name').textContent = selected.name;
  gallery.querySelector('#palette-dot').style.setProperty('--swatch', selected.color);
  if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches)
    await next
      .animate([{ opacity: 0 }, { opacity: 1 }], { duration: 450, easing: 'ease' })
      .finished.catch(() => {});
  previous.remove();
}
for (const button of gallery.querySelectorAll('[data-palette-step]')) {
  button.hidden = false;
  button.addEventListener('click', () => {
    const index = options.findIndex((option) => option.id === palette);
    palette =
      options[(index + Number(button.dataset.paletteStep) + options.length) % options.length].id;
    showPalette();
  });
}
systemTheme.addEventListener('change', showPalette);
async function syncPaletteTheme() {
  await showPalette(false);
}
const observer = new IntersectionObserver(
  (entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    visible = true;
    // The first picture appears as it is; only a change of scheme cross-fades.
    showPalette(false);
    observer.disconnect();
  },
  { rootMargin: '200px' },
);
observer.observe(gallery);
gallery.querySelector('.palette-modes').hidden = false;
