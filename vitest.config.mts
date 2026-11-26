import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@pdf-core': fileURLToPath(new URL('packages/pdf-core/src', import.meta.url)) } },
  test: { include: ['packages/**/*.test.ts'], environment: 'node', testTimeout: 30_000 },
});
