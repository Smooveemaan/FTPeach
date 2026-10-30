import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
