/* exported syncPaletteTheme */
/* global document, matchMedia, Image, IntersectionObserver, getComputedStyle */
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

// Previews fetched and decoded ahead: the shown scheme's neighbours and its other appearance, and a
// swatch under the pointer, so choosing one shows it at once. A failed one is fetched again next time.
const fetched = new Map();
function fetchPreview(id, appearance) {
  const src = `palettes/${id}-${appearance}.webp`;
  if (!fetched.has(src)) {
    const image = new Image();
    image.src = src;
    fetched.set(
      src,
      image.decode().catch((error) => {
        fetched.delete(src);
        throw error;
      }),
    );
  }
  return fetched.get(src);
}
function fetchAround() {
  const index = options.findIndex((option) => option.id === palette);
  for (const step of [-1, 1])
    fetchPreview(options[(index + step + options.length) % options.length].id, currentMode()).catch(
      () => {},
    );
  fetchPreview(palette, currentMode() === 'dark' ? 'light' : 'dark').catch(() => {});
}

async function showPalette(animate = true) {
  if (!visible) return;
  const request = ++revision;
  const selected = options.find((button) => button.id === palette);
  const appearance = currentMode();
  gallery.querySelector('.palette-error').hidden = true;
  try {
    await fetchPreview(palette, appearance);
  } catch {
    if (request === revision) gallery.querySelector('.palette-error').hidden = false;
    return;
  }
  const next = new Image();
  next.src = `palettes/${palette}-${appearance}.webp`;
  next.alt = `FTPeach in ${selected.name}, ${appearance} mode`;
  await next.decode().catch(() => {});
  // A slower earlier request must never replace the visitor's latest choice.
  if (request !== revision) return;
  const previous = preview.lastElementChild;
  preview.append(next);
  for (const button of modes)
    button.setAttribute('aria-pressed', String(button.dataset.mode === appearance));
  gallery.querySelector('#palette-name').textContent = selected.name;
  gallery.querySelector('#palette-dot').style.setProperty('--swatch', selected.color);
  fetchAround();
  if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const duration = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--fade'),
    );
    await next
      .animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: 'ease' })
      .finished.catch(() => {});
  }
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
