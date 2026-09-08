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
  },
});
