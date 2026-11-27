/// <reference lib="webworker" />
// pdf-core's Web Worker. The page hands it the files' bytes (transferred, never
// uploaded); it answers with the result's bytes and a report, also transferred.
// Long jobs send progress messages on the way.
import { browserCodec } from './codec-browser';
import type { CleanReport } from './clean';
import type { CompressReport, Level } from './compress';
import type { ImagesReport, Paper } from './images';
import { UnsupportedImage } from './images';
import { interpretPage } from './interpret';
import { openPdf, PasswordRequired, type Encryption } from './open';
import { cleanFile, compressFile, imagesFile, mergeFiles, organizeFile, splitFile, SourceError, type SplitMode, type SplitReport, type StructureReport } from './ops';
import { PageRangeError } from './structure';

export interface Src { bytes: ArrayBuffer; password?: string }
export type PageSummary = { glyphs: number; unreadable: number; images: number; forms: number; fonts: string[] };

export type CoreRequest =
  | { id: number; type: 'inspect'; file: Src; detail?: boolean }
  | { id: number; type: 'merge'; files: Src[] }
  | { id: number; type: 'organize'; file: Src; pages: { page: number; rotate: number }[] }
  | { id: number; type: 'split'; file: Src; mode: SplitMode; ranges: string; base: string }
  | { id: number; type: 'images'; images: ArrayBuffer[]; paper: Paper }
  | { id: number; type: 'compress'; file: Src; level: Level }
  | { id: number; type: 'clean'; file: Src };

export interface Inspection { pages: number; encryption: Encryption; producer: string; summary: PageSummary[]; ms: number }
export type Reports = {
  merge: StructureReport; organize: StructureReport; split: SplitReport; images: ImagesReport;
  compress: CompressReport & { encryption: Encryption }; clean: CleanReport & { encryption: Encryption };
};
export type Output<K extends keyof Reports = keyof Reports> = { bytes: ArrayBuffer; name?: string; mime: string; report: Reports[K] };

export type ErrorCode = 'password' | 'wrong-password' | 'unreadable' | 'ranges' | 'unsupported-image' | 'failed';
export type CoreResponse =
  | { id: number; kind: 'progress'; stage: string; done: number; total: number }
  | { id: number; kind: 'inspect'; ok: true; result: Inspection }
  | { id: number; kind: 'output'; ok: true; result: Output }
  | { id: number; kind: 'error'; ok: false; error: ErrorCode; file?: number; message: string };

declare const self: DedicatedWorkerGlobalScope;

const u8 = (b: ArrayBuffer) => new Uint8Array(b);
const src = (s: Src) => ({ bytes: u8(s.bytes), password: s.password });
const owned = (b: Uint8Array): ArrayBuffer => (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && b.buffer instanceof ArrayBuffer
  ? b.buffer : b.slice().buffer as ArrayBuffer);

async function inspect(file: Src, detail: boolean): Promise<Inspection> {
  const t0 = performance.now();
  const opened = await openPdf(u8(file.bytes), file.password);
  const summary = detail ? opened.doc.getPages().map((p): PageSummary => {
    const rec = interpretPage(opened.doc, p.node);
    return {
      glyphs: rec.glyphs.length,
      unreadable: rec.glyphs.filter((g) => g.uni === undefined).length,
      images: rec.images.length + rec.inlineImages.length,
      forms: rec.formUses.length,
      fonts: [...new Set(rec.glyphs.map((g) => `${g.font.kind} · ${g.font.enc}`))],
    };
  }) : [];
  return { pages: opened.pages, encryption: opened.encryption, producer: opened.producer, summary, ms: Math.round(performance.now() - t0) };
}

async function run(req: CoreRequest): Promise<Output> {
  const pdf = 'application/pdf';
  switch (req.type) {
    case 'merge': { const r = await mergeFiles(req.files.map(src)); return { bytes: owned(r.bytes), mime: pdf, report: r.report }; }
    case 'organize': { const r = await organizeFile(src(req.file), req.pages); return { bytes: owned(r.bytes), mime: pdf, report: r.report }; }
    case 'split': {
      const r = await splitFile(src(req.file), req.mode, req.ranges, req.base);
      return { bytes: owned(r.bytes), name: r.name, mime: r.report.zipped ? 'application/zip' : pdf, report: r.report };
    }
    case 'images': { const r = await imagesFile(req.images.map(u8), req.paper); return { bytes: owned(r.bytes), mime: pdf, report: r.report }; }
    case 'compress': {
      const r = await compressFile(src(req.file), req.level, browserCodec,
        (p) => self.postMessage({ id: req.id, kind: 'progress', ...p } satisfies CoreResponse));
      return { bytes: owned(r.bytes), mime: pdf, report: r.report };
    }
    case 'clean': { const r = await cleanFile(src(req.file)); return { bytes: owned(r.bytes), mime: pdf, report: r.report }; }
    default: throw new Error('unknown request');
  }
}

function failure(id: number, e: unknown): CoreResponse {
  const file = e instanceof SourceError ? e.index : undefined;
  const cause = e instanceof SourceError ? e.cause : e;
  const message = String((cause as Error)?.message ?? cause).slice(0, 300);
  let error: ErrorCode = 'failed';
  if (cause instanceof PasswordRequired) error = cause.wrongPassword ? 'wrong-password' : 'password';
  else if (cause instanceof PageRangeError) error = 'ranges';
  else if (cause instanceof UnsupportedImage) return { id, kind: 'error', ok: false, error: 'unsupported-image', file: cause.index, message };
  else if (e instanceof SourceError) error = 'unreadable';
  return { id, kind: 'error', ok: false, error, file, message };
}

self.onmessage = async (ev: MessageEvent<CoreRequest>) => {
  const req = ev.data;
  try {
    if (req.type === 'inspect') {
      self.postMessage({ id: req.id, kind: 'inspect', ok: true, result: await inspect(req.file, req.detail ?? false) } satisfies CoreResponse);
      return;
    }
    const result = await run(req);
    self.postMessage({ id: req.id, kind: 'output', ok: true, result } satisfies CoreResponse, [result.bytes]);
  } catch (e) {
    const wrapped = req.type === 'inspect' ? new SourceError(0, e) : e;
    self.postMessage(failure(req.id, wrapped));
  }
};
