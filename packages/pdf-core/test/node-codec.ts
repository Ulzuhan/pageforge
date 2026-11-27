// The image codec for the tests, on @napi-rs/canvas. Like the browser's, it
// decodes without applying a colour profile: pdf-core hands it the JPEG with
// its APP2 already removed.
import { createCanvas, loadImage, type Canvas, type Image } from '@napi-rs/canvas';
import type { ImageCodec } from '@pdf-core';

type Src = Image | Canvas;

export const nodeCodec: ImageCodec<Src> = {
  fromJpeg: (bytes) => loadImage(Buffer.from(bytes)),
  async fromPixels(rgba, width, height) {
    const c = createCanvas(width, height);
    const g = c.getContext('2d');
    const id = g.createImageData(width, height);
    id.data.set(rgba);
    g.putImageData(id, 0, 0);
    return c;
  },
  async toJpeg(src, width, height, quality) {
    const c = createCanvas(width, height);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, width, height);
    return new Uint8Array(c.toBuffer('image/jpeg', Math.round(quality * 100)));
  },
};

/** Draws page `index` with pdf.js (Node, legacy build) and returns its RGBA pixels. */
export async function render(bytes: Uint8Array, index: number, scale = 1) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const base = new URL('../../../node_modules/pdfjs-dist/', import.meta.url).pathname;
  const task = pdfjs.getDocument({
    data: bytes.slice(), standardFontDataUrl: `${base}standard_fonts/`, cMapUrl: `${base}cmaps/`, cMapPacked: true,
    wasmUrl: `${base}wasm/`, iccUrl: `${base}iccs/`, verbosity: 0,
  });
  const doc = await task.promise;
  const page = await doc.getPage(index + 1);
  const vp = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport: vp }).promise;
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  await task.destroy();
  return { width: canvas.width, height: canvas.height, data };
}

/** Mean absolute difference per channel, on the 0–255 scale. */
export function mad(a: { data: Uint8ClampedArray }, b: { data: Uint8ClampedArray }) {
  let s = 0, n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let k = 0; k < 3; k++) s += Math.abs(a.data[i + k] - b.data[i + k]);
    n += 3;
  }
  return s / n;
}
