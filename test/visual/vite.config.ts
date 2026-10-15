import { defineConfig, mergeConfig } from 'vite';
import base from '../../vite.config.ts';

// The visual harness built once for a run: each test then loads a few bundled
// files instead of the dev server's hundreds of modules in a fresh context.
export default mergeConfig(
  base,
  defineConfig({
    build: {
      outDir: 'test-results/visual-build',
      emptyOutDir: true,
      manifest: false,
      rollupOptions: { input: 'test/visual/visual.html' },
    },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  }),
);
