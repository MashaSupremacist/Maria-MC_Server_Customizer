import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['renderer/src/**/*.test.{ts,tsx}'],
    setupFiles: ['renderer/src/test/setup.ts'],
    restoreMocks: true,
  },
});
