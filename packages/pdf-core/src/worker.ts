/// <reference lib="webworker" />
// pdf-core's Web Worker. The page hands it the file's bytes (transferred, never
// uploaded); it answers with what it found. In F2 it only inspects: open, read
// every glyph of every page, and report. Surgery and compression come later.
import { interpretPage } from './interpret';
import { openPdf, PasswordRequired } from './open';

export type CoreRequest = { id: number; type: 'inspect'; bytes: ArrayBuffer; password?: string };
export type PageSummary = { glyphs: number; unreadable: number; images: number; forms: number; fonts: string[] };
export type CoreResponse =
  | { id: number; ok: true; pages: number; encryption: string; producer: string; summary: PageSummary[]; ms: number }
  | { id: number; ok: false; error: 'password' | 'wrong-password' | 'unreadable'; message: string };

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (ev: MessageEvent<CoreRequest>) => {
  const { id, bytes, password } = ev.data;
  const t0 = performance.now();
  try {
    const opened = await openPdf(new Uint8Array(bytes), password);
    const summary = opened.doc.getPages().map((p): PageSummary => {
      const rec = interpretPage(opened.doc, p.node);
      return {
        glyphs: rec.glyphs.length,
        unreadable: rec.glyphs.filter((g) => g.uni === undefined).length,
        images: rec.images.length + rec.inlineImages.length,
        forms: rec.formUses.length,
        fonts: [...new Set(rec.glyphs.map((g) => `${g.font.kind} · ${g.font.enc}`))],
      };
    });
    const res: CoreResponse = { id, ok: true, pages: opened.pages, encryption: opened.encryption, producer: opened.producer,
      summary, ms: Math.round(performance.now() - t0) };
    self.postMessage(res);
  } catch (e) {
    const error = e instanceof PasswordRequired ? (e.wrongPassword ? 'wrong-password' : 'password') : 'unreadable';
    const res: CoreResponse = { id, ok: false, error, message: String((e as Error)?.message ?? e).slice(0, 200) };
    self.postMessage(res);
  }
};
