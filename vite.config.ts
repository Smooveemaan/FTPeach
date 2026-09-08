import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Vite dev server injects an inline <script> for the React Fast Refresh
// preamble, which the shipped app's strict `script-src 'self'` CSP would
// block. That preamble never reaches production builds, so relax CSP only
// for `vite dev` and leave the built dist/index.html untouched.
const relaxCspForDev: Plugin = {
  name: 'relax-csp-for-dev',
  apply: 'serve',
  transformIndexHtml(html: string) {
    return html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';");
  },
};

export default defineConfig({
  plugins: [react(), relaxCspForDev],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    manifest: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Transform the startup graph while Cargo prepares the native process.
    warmup: {
      clientFiles: ['./src/main.tsx', './src/App.tsx', './src/platform/tauriApi.ts'],
    },
    watch: {
      ignored: [
        '**/.vs/**',
        '**/.git/**',
        '**/node_modules/**',
        '**/release/**',
        '**/dist/**',
        // Native SDKs and local build caches are not renderer sources. Crawling
        // them on startup can block Vite's first responses for several seconds.
        '**/.tools/**',
        '**/.local/**',
        // Rust build output under src-tauri/target churns constantly while
        // `cargo` compiles — Vite watching it too races cargo's own writes
        // (EBUSY on Windows) and crashes the whole `tauri dev` process.
        '**/src-tauri/target/**',
      ],
    },
  },
});
