// Applies the remembered theme before the first paint, and marks that scripts run, so controls
// that need them show from the first paint too. Each page puts the reader back itself after a
// reload, once its layout is settled; the browser's own restore lands off and drifts.
document.documentElement.classList.add('js');
history.scrollRestoration = 'manual';
try {
  const saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch {}
