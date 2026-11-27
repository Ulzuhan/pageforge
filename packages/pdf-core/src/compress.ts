// Compression in three levels (plan §4, spike P6).
//
//  lossless  streams without compression, or badly compressed, go through
//            Flate; identical streams are stored once; what nothing points to
//            goes; the file is saved with object streams.
//  medium    the same, plus images as JPEG at quality 0.75, no more than
//            150 ppi at the size they are shown on the page («effective» ppi,
//            from the interpreter's matrix at each Do).
//  strong    the same at quality 0.6 and 100 ppi.
//
// Images that are touched: JPEG in DeviceRGB or DeviceGray, Flate 8-bit RGB or
// gray (with or without PNG predictors), and ICCBased with three components,
// whose /ColorSpace is kept: they are decoded WITHOUT the profile (otherwise the
// canvas applies it and the colour shifts, 11.1/255 in the spike) and the
// original profile is given back to the new JPEG. Never touched: CMYK, indexed,
// 16-bit, masks, /Decode arrays, colour-key masks, soft masks with /Matte.
//
// Honesty rules: an image is replaced only if the new one is smaller, and the
// output is never larger than the input (then the input comes back as it was).
import { PDFArray, PDFBool, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream, type PDFDocument } from '@cantoo/pdf-lib';
import { unzlibSync, zlibSync } from 'fflate';
import { collectGarbage, dedupeStreams } from './dedupe';
import { interpretPage } from './interpret';
import { bare, iccSegments, insertAfterApp0, jpegInfo, withoutIcc } from './jpeg';
import { N, filters, get, look, name, num, streamBytes } from './objects';

export type Level = 'lossless' | 'medium' | 'strong';
export const LEVELS: Record<Level, { quality: number; ppi: number } | null> = {
  lossless: null,
  medium: { quality: 0.75, ppi: 150 },
  strong: { quality: 0.6, ppi: 100 },
};

/** Pixels in and JPEG out. The browser uses OffscreenCanvas; the tests use @napi-rs/canvas. */
export interface ImageCodec<S = unknown> {
  /** Decodes a JPEG as it is stored, without colour management. */
  fromJpeg(bytes: Uint8Array): Promise<S>;
  /** RGBA, 8 bits per channel, opaque. */
  fromPixels(rgba: Uint8ClampedArray, width: number, height: number): Promise<S>;
  /** Scales with high-quality smoothing and encodes; quality in 0..1. */
  toJpeg(src: S, width: number, height: number, quality: number): Promise<Uint8Array>;
  release?(src: S): void;
}

export type SkipReason =
  | 'mask' | 'filter' | 'bits' | 'colorspace' | 'icc-components' | 'decode-array' | 'color-key-mask'
  | 'matte' | 'predictor' | 'components' | 'too-large' | 'unreadable';

export interface CompressReport {
  level: Level;
  before: number;
  after: number;
  /** The output was not smaller, so the input came back as it was. */
  unchanged: boolean;
  images: { total: number; replaced: number; downscaled: number; notSmaller: number; skipped: Partial<Record<SkipReason, number>> };
  streams: { recompressed: number; saved: number };
  duplicates: number;
  unused: number;
  ms: number;
}

export type Progress = (p: { stage: 'reading' | 'images' | 'streams' | 'saving'; done: number; total: number }) => void;

const MAX_PIXELS = 80e6; // a 9000×9000 scan; past that, decoding risks the tab
const SOF_COMPONENTS = { rgb: 3, gray: 1 } as const;

type Plan = { kind: 'rgb' | 'gray'; filter: 'dct' | 'flate'; predictor: number; keepColorSpace: boolean };

function classify(doc: PDFDocument, ref: PDFRef, s: PDFRawStream, masks: Set<string>): Plan | SkipReason {
  const ctx = doc.context;
  const d = s.dict;
  const g = (k: string) => look(ctx, d.get(N(k)));
  if (masks.has(String(ref)) || g('ImageMask') === PDFBool.True) return 'mask';
  const f = filters(ctx, s);
  if (f.length !== 1 || (f[0] !== 'DCTDecode' && f[0] !== 'FlateDecode')) return 'filter';
  if (num(g('BitsPerComponent')) !== 8) return 'bits';
  const w = num(g('Width')) ?? 0, h = num(g('Height')) ?? 0;
  if (w * h > MAX_PIXELS || w < 1 || h < 1) return 'too-large';
  const cs = g('ColorSpace');
  let kind: 'rgb' | 'gray';
  let keepColorSpace = true;
  if (cs instanceof PDFName && cs.decodeText() === 'DeviceRGB') kind = 'rgb';
  else if (cs instanceof PDFName && cs.decodeText() === 'DeviceGray') { kind = 'gray'; keepColorSpace = false; }
  else if (cs instanceof PDFArray && name(look(ctx, cs.get(0))) === 'ICCBased') {
    const profile = look(ctx, cs.get(1));
    if (!(profile instanceof PDFRawStream) || num(get(ctx, profile, 'N')) !== 3) return 'icc-components';
    kind = 'rgb';
  } else return 'colorspace';
  if (g('Decode')) return 'decode-array';
  if (g('Mask') instanceof PDFArray) return 'color-key-mask';
  const smask = g('SMask');
  if (smask instanceof PDFRawStream && smask.dict.get(N('Matte'))) return 'matte';
  const colors = SOF_COMPONENTS[kind];
  if (f[0] === 'DCTDecode') {
    if (g('DecodeParms')) return 'predictor';
    try { if (jpegInfo(s.contents).components !== colors) return 'components'; } catch { return 'unreadable'; }
    return { kind, filter: 'dct', predictor: 1, keepColorSpace };
  }
  const dp = g('DecodeParms');
  const predictor = dp instanceof PDFDict ? num(get(ctx, dp, 'Predictor')) ?? 1 : 1;
  if (predictor !== 1 && predictor < 10) return 'predictor';
  if (predictor >= 10 && dp instanceof PDFDict) {
    if ((num(get(ctx, dp, 'Colors')) ?? 1) !== colors || (num(get(ctx, dp, 'BitsPerComponent')) ?? 8) !== 8 || (num(get(ctx, dp, 'Columns')) ?? 1) !== w) return 'predictor';
  }
  return { kind, filter: 'flate', predictor, keepColorSpace };
}

function unpredictPng(data: Uint8Array, w: number, h: number, colors: number): Uint8Array {
  const rl = w * colors, out = new Uint8Array(rl * h);
  if (data.length < (rl + 1) * h) throw new Error('short image data');
  for (let r = 0; r < h; r++) {
    const ft = data[r * (rl + 1)], src = r * (rl + 1) + 1, o = r * rl;
    for (let x = 0; x < rl; x++) {
      const a = x >= colors ? out[o + x - colors] : 0, b = r ? out[o - rl + x] : 0, c = r && x >= colors ? out[o - rl + x - colors] : 0;
      let v = data[src + x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[o + x] = v & 0xff;
    }
  }
  return out;
}

async function decode<S>(codec: ImageCodec<S>, s: PDFRawStream, plan: Plan, w: number, h: number): Promise<S> {
  if (plan.filter === 'dct') return codec.fromJpeg(withoutIcc(s.contents));
  let raw: Uint8Array = unzlibSync(s.contents);
  const colors = SOF_COMPONENTS[plan.kind];
  if (plan.predictor >= 10) raw = unpredictPng(raw, w, h, colors);
  if (raw.length < w * h * colors) throw new Error('short image data');
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let p = 0, o = 0; p < w * h; p++, o += 4) {
    if (colors === 3) { rgba[o] = raw[p * 3]; rgba[o + 1] = raw[p * 3 + 1]; rgba[o + 2] = raw[p * 3 + 2]; }
    else rgba[o] = rgba[o + 1] = rgba[o + 2] = raw[p];
    rgba[o + 3] = 255;
  }
  return codec.fromPixels(rgba, w, h);
}

/** The lowest effective ppi at which each image is drawn, by reference. */
function effectivePpi(doc: PDFDocument): Map<string, number> {
  const out = new Map<string, number>();
  for (const page of doc.getPages()) {
    let rec;
    try { rec = interpretPage(doc, page.node); } catch { continue; } // that page's images keep their resolution
    for (const im of rec.images) {
      if (!(im.ref instanceof PDFRef)) continue;
      const w = num(get(doc.context, im.obj, 'Width')) ?? 0, h = num(get(doc.context, im.obj, 'Height')) ?? 0;
      const dw = Math.hypot(im.ctm[0], im.ctm[1]) / 72, dh = Math.hypot(im.ctm[2], im.ctm[3]) / 72;
      if (!dw || !dh) continue;
      const ppi = Math.min(w / dw, h / dh);
      const k = String(im.ref);
      out.set(k, Math.min(out.get(k) ?? Infinity, ppi));
    }
  }
  return out;
}

const RECOMPRESSIBLE = new Set(['FlateDecode', 'LZWDecode', 'ASCII85Decode', 'ASCIIHexDecode', 'RunLengthDecode']);

export async function compress<S>(doc: PDFDocument, input: Uint8Array, level: Level, codec: ImageCodec<S> | null, progress: Progress = () => {}):
Promise<{ bytes: Uint8Array; report: CompressReport }> {
  const t0 = performance.now();
  const ctx = doc.context;
  const L = LEVELS[level];
  const report: CompressReport = {
    level, before: input.length, after: 0, unchanged: false,
    images: { total: 0, replaced: 0, downscaled: 0, notSmaller: 0, skipped: {} },
    streams: { recompressed: 0, saved: 0 }, duplicates: 0, unused: 0, ms: 0,
  };
  const skip = (r: SkipReason) => { report.images.skipped[r] = (report.images.skipped[r] ?? 0) + 1; };

  const masks = new Set<string>();
  const images: [PDFRef, PDFRawStream][] = [];
  for (const [ref, o] of ctx.enumerateIndirectObjects()) {
    if (!(o instanceof PDFRawStream) || name(look(ctx, o.dict.get(N('Subtype')))) !== 'Image') continue;
    images.push([ref, o]);
    for (const k of ['SMask', 'Mask']) { const r = o.dict.get(N(k)); if (r instanceof PDFRef) masks.add(String(r)); }
  }
  report.images.total = images.length;

  if (L) {
    if (!codec) throw new Error('this level needs an image codec');
    progress({ stage: 'reading', done: 0, total: doc.getPageCount() });
    const ppi = effectivePpi(doc);
    let done = 0;
    for (const [ref, s] of images) {
      progress({ stage: 'images', done: done++, total: images.length });
      const plan = classify(doc, ref, s, masks);
      if (typeof plan === 'string') { skip(plan); continue; }
      const w = num(look(ctx, s.dict.get(N('Width'))))!, h = num(look(ctx, s.dict.get(N('Height'))))!;
      const shown = ppi.get(String(ref));
      const scale = shown !== undefined && shown > L.ppi * 1.1 ? L.ppi / shown : 1;
      const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
      let src: S;
      try { src = await decode(codec, s, plan, w, h); } catch { skip('unreadable'); continue; }
      let out: Uint8Array;
      try { out = bare(await codec.toJpeg(src, nw, nh, L.quality)); } catch { skip('unreadable'); continue; } finally { codec.release?.(src); }
      if (plan.filter === 'dct') out = insertAfterApp0(out, iccSegments(s.contents));
      if (out.length >= s.contents.length) { report.images.notSmaller++; continue; }
      const nd = s.dict.clone(ctx);
      nd.set(N('Width'), PDFNumber.of(nw));
      nd.set(N('Height'), PDFNumber.of(nh));
      nd.set(N('Filter'), N('DCTDecode'));
      nd.set(N('BitsPerComponent'), PDFNumber.of(8));
      nd.delete(N('DecodeParms'));
      nd.delete(N('Length'));
      // The canvas only writes three-channel JPEG; an ICC array stays as it was.
      if (!plan.keepColorSpace) nd.set(N('ColorSpace'), N('DeviceRGB'));
      ctx.assign(ref, PDFRawStream.of(nd, out));
      report.images.replaced++;
      if (scale < 1) report.images.downscaled++;
    }
    progress({ stage: 'images', done: images.length, total: images.length });
  }

  const all = ctx.enumerateIndirectObjects();
  let done = 0;
  for (const [ref, s] of all) {
    if (done++ % 50 === 0) progress({ stage: 'streams', done, total: all.length });
    if (!(s instanceof PDFRawStream)) continue;
    const type = name(look(ctx, s.dict.get(N('Type'))));
    if (type === 'Metadata' || type === 'XRef' || type === 'ObjStm' || s.dict.has(N('F'))) continue;
    const f = filters(ctx, s);
    const dp = look(ctx, s.dict.get(N('DecodeParms')));
    let raw: Uint8Array;
    let keepParms = false;
    try {
      if (f.length === 0) raw = s.contents;
      else if (f.length === 1 && f[0] === 'FlateDecode') { raw = unzlibSync(s.contents); keepParms = true; }
      else if (f.every((x) => RECOMPRESSIBLE.has(x)) && !dp) raw = decodePDFRawStream(s).decode();
      else continue;
    } catch { continue; }
    const z = zlibSync(raw, { level: 9 });
    if (z.length >= s.contents.length) continue;
    const nd = s.dict.clone(ctx);
    nd.set(N('Filter'), N('FlateDecode'));
    nd.delete(N('Length'));
    if (!keepParms) nd.delete(N('DecodeParms'));
    report.streams.saved += s.contents.length - z.length;
    report.streams.recompressed++;
    ctx.assign(ref, PDFRawStream.of(nd, z));
  }

  progress({ stage: 'saving', done: 0, total: 1 });
  report.duplicates = await dedupeStreams(doc);
  report.unused = await collectGarbage(doc);
  let bytes: Uint8Array = await doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
  if (bytes.length >= input.length) { bytes = input; report.unchanged = true; }
  report.after = bytes.length;
  report.ms = Math.round(performance.now() - t0);
  return { bytes, report };
}

/**
 * For the tests: the decoded bytes of every stream that is not an image, by
 * object. The file's own object streams and cross-reference stream are left
 * out (the parser keeps them as objects; the garbage collection drops them).
 */
export function streamDigest(doc: PDFDocument): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [ref, s] of doc.context.enumerateIndirectObjects()) {
    if (!(s instanceof PDFRawStream) || name(look(doc.context, s.dict.get(N('Subtype')))) === 'Image') continue;
    const type = name(look(doc.context, s.dict.get(N('Type'))));
    if (type === 'XRef' || type === 'ObjStm') continue;
    try { out.set(String(ref), streamBytes(doc.context, s)); } catch { /* filters pdf-lib cannot decode */ }
  }
  return out;
}
