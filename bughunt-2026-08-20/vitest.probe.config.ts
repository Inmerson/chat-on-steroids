import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['bughunt-2026-08-20/**/*.test.ts'], environment: 'node' } });
