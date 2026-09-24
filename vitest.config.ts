import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/component/helpers/setup.ts'],
    // Node tests live in test/unit; each runner owns a separate directory.
    include: ['test/component/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    // Used by `npm run coverage`. Every production file counts, loaded or not;
    // see docs/coverage.md for what is left out and why.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/graphify-out/**'],
      reporter: ['json', 'json-summary', 'html', 'text-summary'],
      reportsDirectory: 'coverage/component',
    },
  },
});
