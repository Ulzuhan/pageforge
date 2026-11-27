// pdf.js, off the main thread and fed from memory, for previews. The file is
// read with the File API and never leaves the browser.
import * as pdfjs from 'pdfjs-dist';
import { newPdfjsWorker } from './workers';

let pdfjsReady = false;
function setUpPdfjs() {
  if (pdfjsReady) return;
  pdfjs.GlobalWorkerOptions.workerPort = newPdfjsWorker();
  pdfjsReady = true;
}

// Every resource pdf.js may fetch comes from this origin (connect-src 'self').
const BASE = new URL('/pdfjs/', location.href).href;

export type Preview = { doc: pdfjs.PDFDocumentProxy; close: () => Promise<void> };

export async function openForPreview(bytes: ArrayBuffer, password?: string): Promise<Preview> {
  setUpPdfjs();
  // pdf.js TRANSFERS the buffer to its worker and leaves it unusable here: it
  // always gets a copy (a lesson from SignDrop that only a browser test caught).
  // No isEvalSupported: pdf.js 6.5 no longer has it nor uses eval (spike, P1);
  // the CSP, without 'unsafe-eval', is the defence.
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes.slice(0)), password,
    cMapUrl: BASE + 'cmaps/', cMapPacked: true, standardFontDataUrl: BASE + 'standard_fonts/',
    wasmUrl: BASE + 'wasm/', iccUrl: BASE + 'iccs/', useSystemFonts: false, enableXfa: false,
  });
  return { doc: await task.promise, close: () => task.destroy() };
}

/** One page as a PNG blob URL, `width` CSS pixels wide (at the screen's density). The caller revokes it. */
export async function renderThumbnail(doc: pdfjs.PDFDocumentProxy, pageNumber: number, width = 160): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const density = Math.min(2, globalThis.devicePixelRatio || 1);
  const vp = page.getViewport({ scale: (width * density) / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  await page.render({ canvas, viewport: vp, intent: 'print' }).promise;
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  page.cleanup();
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error('could not draw the page');
  return URL.createObjectURL(blob);
}
