import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Real filesystem, real child processes and a real HTTP server, so the
    // defaults are too tight.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
