import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@helm/core': r('./packages/core/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'apps/bridge/src/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    globals: false,
    pool: 'forks',
  },
});
