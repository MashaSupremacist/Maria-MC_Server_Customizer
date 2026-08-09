import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 10000,
    // Several suites exercise real child processes and local HTTP servers.
    // Running files concurrently makes their timing assertions contend in CI.
    fileParallelism: false,
  },
});
