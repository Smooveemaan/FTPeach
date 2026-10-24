// Applies the remembered theme before the first paint, and marks that scripts run, so controls
// that need them show from the first paint too. Each page puts the reader back itself after a
// reload, once its layout is settled; the browser's own restore lands off and drifts.
document.documentElement.classList.add('js');
history.scrollRestoration = 'manual';
try {
  const saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch {}

/* exported switchTheme */
// The whole page changes theme as one cross-fade at one speed (--fade), pictures included: `change`
// may return a promise that holds the new look back until its pictures are decoded, so nothing
// appears late. Elements' own colour transitions are off meanwhile, so none lags behind the rest.
// The wait is capped: a click before the pictures arrived would freeze the page (Chrome up to 4 s).
function switchTheme(change) {
  const root = document.documentElement;
  root.classList.add('theme-switch');
  const done = () => root.classList.remove('theme-switch');
  const update = () => Promise.race([change(), new Promise((resolve) => setTimeout(resolve, 500))]);
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update().finally(() => {
      void root.offsetWidth;
      requestAnimationFrame(done);
    });
    return;
  }
  document.startViewTransition(update).finished.finally(done);
}
