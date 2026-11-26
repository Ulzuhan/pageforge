// pdf.js and pdf-core, both off the main thread, both fed from memory. The file
// is read with the File API and never leaves the browser.
import * as pdfjs from 'pdfjs-dist';
import type { CoreRequest, CoreResponse } from '@pdf-core/worker';
import { newCoreWorker, newPdfjsWorker } from './workers';

let pdfjsReady = false;
function setUpPdfjs() {
  if (pdfjsReady) return;
  pdfjs.GlobalWorkerOptions.workerPort = newPdfjsWorker();
  pdfjsReady = true;
}

// Every resource pdf.js may fetch comes from this origin (connect-src 'self').
const BASE = new URL('/pdfjs/', location.href).href;

export async function openForPreview(bytes: ArrayBuffer, password?: string) {
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

export async function renderThumbnail(doc: pdfjs.PDFDocumentProxy, pageNumber: number, width = 160): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / base.width });
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

let core: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (r: CoreResponse) => void>();

export function inspect(bytes: ArrayBuffer, password?: string): Promise<CoreResponse> {
  if (!core) {
    core = newCoreWorker();
    core.onmessage = (ev: MessageEvent<CoreResponse>) => {
      pending.get(ev.data.id)?.(ev.data);
      pending.delete(ev.data.id);
    };
  }
  const id = nextId++;
  const copy = bytes.slice(0);
  const req: CoreRequest = { id, type: 'inspect', bytes: copy, password };
  return new Promise((resolve) => {
    pending.set(id, resolve);
    core!.postMessage(req, [copy]);
  });
}
