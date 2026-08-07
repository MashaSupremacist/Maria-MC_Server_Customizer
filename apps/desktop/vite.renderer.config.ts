import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: path.resolve(dirname, 'renderer'),
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@msc/shared-types': path.resolve(
        dirname,
        '../../packages/shared-types/src/index.ts',
      ),
      '@renderer': path.resolve(dirname, 'renderer/src'),
    },
  },
  build: {
    outDir: path.resolve(dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
});
