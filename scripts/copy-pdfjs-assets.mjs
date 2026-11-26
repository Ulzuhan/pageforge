// pdf.js' worker comes in through Vite; its other resources (CMaps, the 14
// standard fonts, the wasm decoders and ICC profiles) are copied next to each
// tool so they are served from the same origin. No CDN, ever.
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const src = here('../node_modules/pdfjs-dist/');
for (const tool of ['pageforge', 'inkbar']) {
  const dst = here(`../apps/${tool}/public/pdfjs/`);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) cpSync(src + d, dst + d, { recursive: true });
}
console.log('pdf.js resources copied');
