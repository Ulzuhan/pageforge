/// <reference lib="webworker" />
// The image codec in the browser, inside pdf-core's worker: createImageBitmap
// decodes (with colorSpaceConversion: 'none', so the ICC profile is NOT applied:
// the profile stays in the PDF's /ColorSpace, spike P6) and OffscreenCanvas
// scales and encodes. Nothing here fetches anything.
import type { ImageCodec } from './compress';

export const browserCodec: ImageCodec<ImageBitmap> = {
  fromJpeg: (bytes) => createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/jpeg' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }),
  fromPixels: (rgba, width, height) => createImageBitmap(new ImageData(rgba as ImageDataArray, width, height), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }),
  async toJpeg(src, width, height, quality) {
    const canvas = new OffscreenCanvas(width, height);
    const g = canvas.getContext('2d', { alpha: false });
    if (!g) throw new Error('no 2D context');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return new Uint8Array(await blob.arrayBuffer());
  },
  release: (src) => src.close(),
};
