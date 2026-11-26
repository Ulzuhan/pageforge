// Content stream interpreter: walks a page (and its Form XObjects) with the
// graphics and text state, and reports where every glyph, image and path falls.
// It is the base for InkBar's surgery and for compression; it changes nothing.
import { PDFDict, PDFRef, PDFStream, type PDFDocument, type PDFObject } from '@cantoo/pdf-lib';
import { makeFontReader, type FontInfo } from './fonts';
import {
  IDENTITY, N, apply, bboxOf, get, look, mul, name, nums, pageContent, pageResources, streamBytes,
  type Box, type Matrix, type Point,
} from './objects';
import { tokenize, type Op, type Token } from './tokenize';

export interface Glyph {
  /** Stream key ('page' or 'form:<ref>#<n>'), operation index, TJ element, byte offset. */
  stream: string; op: number; element: number; offset: number;
  code: number;
  uni: string | undefined;
  bbox: Box;
  quad: [Point, Point, Point, Point];
  origin: Point;
  /** Baseline start and end without text rise (Ts): what pdfminer measures. */
  base: Point; baseEnd: Point;
  end: Point;
  /** TJ adjustment that keeps everything after this glyph in place if it is removed. */
  compensation: number | null;
  fontSize: number;
  renderMode: number;
  font: FontInfo;
}

export interface PageRecord {
  streams: Map<string, { ops: Op[]; resources: PDFDict; bytes: Uint8Array }>;
  glyphs: Glyph[];
  images: { stream: string; op: number; name: string; ref: PDFObject | undefined; obj: PDFStream; ctm: Matrix; bbox: Box }[];
  inlineImages: { stream: string; op: number; bbox: Box }[];
  shadings: { stream: string; op: number }[];
  paths: { stream: string; op0: number; op1: number; bbox: Box; curve: boolean; clip: boolean; paint: boolean }[];
  formUses: { parent: string; op: number; name: string; ref: PDFObject | undefined; key: string }[];
  marked: { stream: string; op: number; operator: string; props: Token | undefined }[];
  unknown: { stream: string; op: number; what: string }[];
}

interface GraphicsState {
  ctm: Matrix; tc: number; tw: number; th: number; tl: number;
  font: FontInfo | null; fs: number; rise: number; mode: number;
}

const unitBox = (ctm: Matrix) => bboxOf([apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 1, 1), apply(ctm, 0, 1)]);
const MAX_FORM_DEPTH = 12; // cycles (a form that draws itself) stop here

export function interpretPage(doc: PDFDocument, page: PDFDict): PageRecord {
  const ctx = doc.context;
  const readFont = makeFontReader(ctx);
  const rec: PageRecord = { streams: new Map(), glyphs: [], images: [], inlineImages: [], shadings: [], paths: [], formUses: [], marked: [], unknown: [] };
  let formCounter = 0;

  function run(key: string, bytes: Uint8Array, resources: PDFDict, ctm0: Matrix, depth: number) {
    const ops = tokenize(bytes);
    rec.streams.set(key, { ops, resources, bytes });
    let gs: GraphicsState = { ctm: ctm0, tc: 0, tw: 0, th: 1, tl: 0, font: null, fs: 0, rise: 0, mode: 0 };
    const stack: GraphicsState[] = [];
    let Tm: Matrix = IDENTITY, Tlm: Matrix = IDENTITY;
    // A box, not a plain let: TypeScript cannot see the closures below assign it.
    const cur: { path: { op0: number; pts: Point[]; curve: boolean } | null } = { path: null };
    let clip = false;

    const resource = (n: string, cat: string): { ref: PDFObject | undefined; obj: PDFObject | undefined } => {
      const d = get(ctx, resources, cat);
      if (!(d instanceof PDFDict)) return { ref: undefined, obj: undefined };
      const ref = d.get(N(n));
      return { ref, obj: look(ctx, ref) };
    };
    const num = (o: Token | undefined) => (o && o.t === 'num' ? o.v : 0);
    const matrix = (o: Token[]) => [num(o[0]), num(o[1]), num(o[2]), num(o[3]), num(o[4]), num(o[5])] as Matrix;

    const show = (k: number, element: number, str: Uint8Array) => {
      const f = gs.font;
      if (!f) return;
      for (let ci = 0; ci + f.bytesPerCode <= str.length; ci += f.bytesPerCode) {
        const code = f.bytesPerCode === 2 ? (str[ci] << 8) | str[ci + 1] : str[ci];
        const w0 = f.width(code);
        const trm = mul([gs.fs * gs.th, 0, 0, gs.fs, 0, gs.rise], mul(Tm, gs.ctm));
        const w = w0 / 1000, a = f.ascent / 1000, dsc = f.descent / 1000;
        const quad: Glyph['quad'] = [apply(trm, 0, dsc), apply(trm, w, dsc), apply(trm, w, a), apply(trm, 0, a)];
        const isSpace = f.bytesPerCode === 1 && code === 32;
        const nr = mul([gs.fs * gs.th, 0, 0, gs.fs, 0, 0], mul(Tm, gs.ctm));
        rec.glyphs.push({
          stream: key, op: k, element, offset: ci, code, uni: f.uni(code), bbox: bboxOf(quad), quad, origin: apply(trm, 0, 0),
          base: apply(nr, 0, 0), baseEnd: apply(nr, w, 0), end: apply(trm, w, 0),
          compensation: gs.fs ? -(w0 + (gs.tc + (isSpace ? gs.tw : 0)) * 1000 / gs.fs) : null,
          fontSize: gs.fs, renderMode: gs.mode, font: f,
        });
        Tm = mul([1, 0, 0, 1, (w * gs.fs + gs.tc + (isSpace ? gs.tw : 0)) * gs.th, 0], Tm);
      }
    };
    const point = (x: number, y: number) => cur.path!.pts.push(apply(gs.ctm, x, y));
    const startPath = (k: number) => { if (!cur.path) cur.path = { op0: k, pts: [], curve: false }; };
    const nextLine = () => { Tlm = mul([1, 0, 0, 1, 0, -gs.tl], Tlm); Tm = Tlm; };

    for (let k = 0; k < ops.length; k++) {
      const { op, operands: o } = ops[k];
      switch (op) {
        case 'q': stack.push({ ...gs }); break;
        case 'Q': if (stack.length) gs = stack.pop()!; break;
        case 'cm': gs.ctm = mul(matrix(o), gs.ctm); break;
        case 'BT': Tm = Tlm = IDENTITY; break;
        case 'Tf': {
          const fontName = o[0]?.t === 'name' ? o[0].v : '';
          const r = resource(fontName, 'Font');
          gs.font = r.ref instanceof PDFRef || r.ref instanceof PDFDict ? readFont(r.ref) : null;
          gs.fs = num(o[1]);
          if (!gs.font) rec.unknown.push({ stream: key, op: k, what: `font ${fontName} not found` });
          break;
        }
        case 'Tc': gs.tc = num(o[0]); break;
        case 'Tw': gs.tw = num(o[0]); break;
        case 'Tz': gs.th = num(o[0]) / 100; break;
        case 'TL': gs.tl = num(o[0]); break;
        case 'Ts': gs.rise = num(o[0]); break;
        case 'Tr': gs.mode = num(o[0]); break;
        case 'Td': Tlm = mul([1, 0, 0, 1, num(o[0]), num(o[1])], Tlm); Tm = Tlm; break;
        case 'TD': gs.tl = -num(o[1]); Tlm = mul([1, 0, 0, 1, num(o[0]), num(o[1])], Tlm); Tm = Tlm; break;
        case 'Tm': Tm = Tlm = matrix(o); break;
        case 'T*': nextLine(); break;
        case 'Tj': if (o[0]?.t === 'str') show(k, 0, o[0].bytes); break;
        case "'": nextLine(); if (o[0]?.t === 'str') show(k, 0, o[0].bytes); break;
        case '"': gs.tw = num(o[0]); gs.tc = num(o[1]); nextLine(); if (o[2]?.t === 'str') show(k, 0, o[2].bytes); break;
        case 'TJ':
          if (o[0]?.t === 'arr') o[0].v.forEach((e, el) => {
            if (e.t === 'num') Tm = mul([1, 0, 0, 1, -e.v / 1000 * gs.fs * gs.th, 0], Tm);
            else if (e.t === 'str') show(k, el, e.bytes);
          });
          break;
        case 'Do': {
          const xname = o[0]?.t === 'name' ? o[0].v : '';
          const r = resource(xname, 'XObject');
          const x = r.obj;
          if (!(x instanceof PDFStream)) { rec.unknown.push({ stream: key, op: k, what: `XObject ${xname} not found` }); break; }
          const subtype = name(get(ctx, x, 'Subtype'));
          if (subtype === 'Form' && depth < MAX_FORM_DEPTH) {
            const m = (nums(ctx, x.dict.get(N('Matrix'))) ?? IDENTITY) as Matrix;
            const fkey = `form:${String(r.ref)}#${formCounter++}`;
            rec.formUses.push({ parent: key, op: k, name: xname, ref: r.ref, key: fkey });
            const own = get(ctx, x, 'Resources');
            run(fkey, streamBytes(ctx, x), own instanceof PDFDict ? own : resources, mul(m, gs.ctm), depth + 1);
          } else if (subtype === 'Image') {
            rec.images.push({ stream: key, op: k, name: xname, ref: r.ref, obj: x, ctm: gs.ctm, bbox: unitBox(gs.ctm) });
          }
          break;
        }
        case 'BI': rec.inlineImages.push({ stream: key, op: k, bbox: unitBox(gs.ctm) }); break;
        case 'sh': rec.shadings.push({ stream: key, op: k }); break;
        case 'BDC': case 'BMC': case 'DP': case 'MP': rec.marked.push({ stream: key, op: k, operator: op, props: o[1] }); break;
        case 'm': case 'l': startPath(k); point(num(o[0]), num(o[1])); break;
        case 'c': startPath(k); cur.path!.curve = true; point(num(o[0]), num(o[1])); point(num(o[2]), num(o[3])); point(num(o[4]), num(o[5])); break;
        case 'v': case 'y': startPath(k); cur.path!.curve = true; point(num(o[0]), num(o[1])); point(num(o[2]), num(o[3])); break;
        case 're': {
          startPath(k);
          const [x, y, w, h] = [num(o[0]), num(o[1]), num(o[2]), num(o[3])];
          point(x, y); point(x + w, y); point(x + w, y + h); point(x, y + h);
          break;
        }
        case 'W': case 'W*': clip = true; break;
        case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': case 'n':
          if (cur.path && cur.path.pts.length) rec.paths.push({ stream: key, op0: cur.path.op0, op1: k, bbox: bboxOf(cur.path.pts), curve: cur.path.curve, clip, paint: op !== 'n' });
          cur.path = null;
          clip = false;
          break;
        default: break;
      }
    }
  }

  run('page', pageContent(ctx, page), pageResources(ctx, page), IDENTITY, 0);
  return rec;
}
