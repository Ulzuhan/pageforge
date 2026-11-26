// One config, two tools: `vite build --mode pageforge` and `--mode inkbar`.
// Each build has two pages: index.html (the public landing) and app/index.html
// (the tool, served by Go only to someone signed in).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig(({ mode }) => {
  if (mode !== 'pageforge' && mode !== 'inkbar') throw new Error(`--mode must be pageforge or inkbar, not ${mode}`);
  return {
    root: here(`apps/${mode}`),
    publicDir: here(`apps/${mode}/public`),
    plugins: [react()],
    resolve: {
      alias: {
        '@pdf-core': here('packages/pdf-core/src'),
        '@shell': here('packages/shell/src'),
      },
    },
    worker: { format: 'es' },
    build: {
      outDir: here(`internal/web/${mode}/dist`),
      emptyOutDir: true,
      target: 'es2023',
      // No data: URIs: the CSP allows img-src 'self' blob: and nothing else.
      assetsInlineLimit: 0,
      // The polyfill injects an inline script, which the CSP would block.
      modulePreload: { polyfill: false },
      sourcemap: false,
      rollupOptions: {
        input: { landing: here(`apps/${mode}/index.html`), app: here(`apps/${mode}/app/index.html`) },
      },
    },
  };
});
