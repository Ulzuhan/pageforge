// Small helpers over @cantoo/pdf-lib's object model: resolve references, read
// numbers and names, decode streams, and find a page's content and resources.
import {
  PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, decodePDFRawStream,
  type PDFContext, type PDFObject,
} from '@cantoo/pdf-lib';

export const N = (s: string) => PDFName.of(s);

export function look(ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? ctx.lookup(o) : o;
}

/** dict[key], resolved. Works on dictionaries and on stream dictionaries. */
export function get(ctx: PDFContext, dict: PDFDict | PDFStream | undefined, key: string): PDFObject | undefined {
  if (!dict) return undefined;
  const d = dict instanceof PDFStream ? dict.dict : dict;
  return look(ctx, d.get(N(key)));
}

export const asDict = (o: PDFObject | undefined) => (o instanceof PDFDict ? o : undefined);
export const asArray = (o: PDFObject | undefined) => (o instanceof PDFArray ? o : undefined);
export const asStream = (o: PDFObject | undefined) => (o instanceof PDFStream ? o : undefined);

export function name(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFName ? o.decodeText() : undefined;
}

export function num(o: PDFObject | undefined): number | undefined {
  return o instanceof PDFNumber ? o.asNumber() : undefined;
}

export function nums(ctx: PDFContext, o: PDFObject | undefined): number[] | undefined {
  const a = asArray(look(ctx, o));
  if (!a) return undefined;
  const out = a.asArray().map((x) => num(look(ctx, x)));
  return out.every((x) => x !== undefined) ? (out as number[]) : undefined;
}

export function filters(ctx: PDFContext, s: PDFStream): string[] {
  const f = look(ctx, s.dict.get(N('Filter')));
  if (!f) return [];
  if (f instanceof PDFArray) return f.asArray().map((x) => name(look(ctx, x)) ?? '?');
  return [name(f) ?? '?'];
}

/** A stream's decoded bytes. Throws on filters pdf-lib cannot decode. */
export function streamBytes(ctx: PDFContext, o: PDFObject | undefined): Uint8Array {
  const s = look(ctx, o);
  if (s instanceof PDFRawStream) return s.dict.get(N('Filter')) ? decodePDFRawStream(s).decode() : s.contents;
  // Streams built in memory (PDFContentStream and friends): their getContents()
  // returns the ENCODED bytes, so ask for the unencoded ones first.
  const built = s as { getUnencodedContents?: () => Uint8Array } | undefined;
  if (s instanceof PDFStream && typeof built?.getUnencodedContents === 'function') return built.getUnencodedContents();
  if (s instanceof PDFStream) return s.getContents();
  throw new Error('not a stream');
}

/** Every content stream of a page, joined with newlines (ISO 32000-1 §7.8.2). */
export function pageContent(ctx: PDFContext, page: PDFDict): Uint8Array {
  const c = look(ctx, page.get(N('Contents')));
  const parts = c instanceof PDFArray ? c.asArray().map((r) => streamBytes(ctx, r)) : c ? [streamBytes(ctx, c)] : [];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length + 1, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; out[o++] = 10; }
  return out;
}

/** A page's resources, inherited from the page tree when the page has none. */
export function pageResources(ctx: PDFContext, page: PDFDict): PDFDict {
  for (let n: PDFDict | undefined = page, depth = 0; n && depth < 64; n = asDict(get(ctx, n, 'Parent')), depth++) {
    const r = asDict(get(ctx, n, 'Resources'));
    if (r) return r;
  }
  return ctx.obj({});
}

export type Matrix = [number, number, number, number, number, number];
export type Point = [number, number];
export type Box = [number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
export const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
export const apply = (m: Matrix, x: number, y: number): Point => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
export function bboxOf(pts: Point[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}

/**
 * Visits every object reachable from the trailer once, nested direct objects
 * included (an /OpenAction written inline is not an indirect object).
 */
export function walk(ctx: PDFContext, visit: (o: PDFObject) => void) {
  const seen = new Set<PDFObject>();
  const go = (o: PDFObject | undefined) => {
    if (!o || seen.has(o)) return;
    seen.add(o);
    if (o instanceof PDFRef) { go(ctx.lookup(o)); return; }
    visit(o);
    if (o instanceof PDFDict) for (const [, v] of o.entries()) go(v);
    else if (o instanceof PDFArray) for (const v of o.asArray()) go(v);
    else if (o instanceof PDFStream) for (const [, v] of o.dict.entries()) go(v); // the stream stands for its dictionary
  };
  const t = ctx.trailerInfo;
  for (const o of [t.Root, t.Info]) go(o as PDFObject | undefined);
}

/** Text of a string object, or undefined. Reading /Producer this way does not create an /Info. */
export function text(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined;
}
