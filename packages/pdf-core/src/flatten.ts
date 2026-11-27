// Annotations that show something (a filled form field, a text box added in
// Preview, a stamp, a drawing) are not part of the page content: they live in
// the annotation's appearance (/AP /N). The sanitized copy removes annotations,
// so before it, every visible appearance is drawn into the page as a Form
// XObject, with the algorithm of ISO 32000-1 §12.5.5: /Matrix takes the /BBox
// to a box, and that box is mapped onto /Rect (spike, P9).
//
// Links and pop-ups have nothing to draw. Hidden annotations (flags Hidden or
// NoView) stay out: what nobody sees is not kept. Annotations without an
// appearance have nothing to draw either and are counted apart, as «blank»
// (Clean first draws the form fields that lack one, from their values).
import { PDFArray, PDFDict, PDFRef, PDFStream, type PDFDocument, type PDFObject, type PDFPage } from '@cantoo/pdf-lib';
import { N, get, look, name, num, nums, pageResources, type Box, type Matrix } from './objects';

const NOTHING_TO_DRAW = new Set(['Link', 'Popup']);

export interface FlattenReport {
  flattened: Record<string, number>;
  /** Hidden (flags Hidden or NoView). */
  dropped: Record<string, number>;
  /** Nothing to draw: no appearance in the file, or an empty one. */
  blank: Record<string, number>;
}

const bump = (r: Record<string, number>, k: string) => { r[k] = (r[k] ?? 0) + 1; };

function transformedBox(b: Box, m: Matrix): Box {
  const pts = [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]].map(([x, y]) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const fmt = (x: number) => (Math.abs(x) < 1e-9 ? '0' : Number(x.toFixed(6)).toString());

export function flattenAnnotations(doc: PDFDocument, page: PDFPage, report: FlattenReport = { flattened: {}, dropped: {}, blank: {} }): FlattenReport {
  const ctx = doc.context;
  const node = page.node;
  const annots = look(ctx, node.get(N('Annots')));
  if (!(annots instanceof PDFArray)) return report;
  const dr = get(ctx, get(ctx, doc.catalog, 'AcroForm') as PDFDict | undefined, 'DR');
  const ops: string[] = [];
  const keep: PDFObject[] = [];
  const added: [string, PDFRef][] = [];
  // New names must not take the place of one the page already uses: a page
  // cleaned before has its PFAnnot0 already.
  const res = pageResources(ctx, node);
  const old = get(ctx, res, 'XObject');
  const taken = new Set(old instanceof PDFDict ? old.keys().map((k) => k.decodeText()) : []);
  let counter = 0;
  const freeName = () => {
    while (taken.has(`PFAnnot${counter}`)) counter++;
    taken.add(`PFAnnot${counter}`);
    return `PFAnnot${counter}`;
  };

  for (const ref of annots.asArray()) {
    const a = look(ctx, ref);
    if (!(a instanceof PDFDict)) continue;
    const subtype = name(get(ctx, a, 'Subtype')) ?? 'Unknown';
    const flags = num(get(ctx, a, 'F')) ?? 0;
    if (NOTHING_TO_DRAW.has(subtype)) { keep.push(ref); continue; }
    if (flags & 2 || flags & 32) { bump(report.dropped, subtype); continue; } // Hidden, NoView
    const apDict = get(ctx, a, 'AP');
    let apRef: PDFObject | undefined = apDict instanceof PDFDict ? apDict.get(N('N')) : undefined;
    let ap = look(ctx, apRef);
    if (ap instanceof PDFDict && !(ap instanceof PDFStream)) { // states (check boxes, radio buttons): the one in /AS
      const as = name(get(ctx, a, 'AS'));
      apRef = as ? ap.get(N(as)) : undefined;
      ap = look(ctx, apRef);
    }
    const rect = nums(ctx, a.get(N('Rect')));
    if (!(ap instanceof PDFStream) || !rect || rect.length !== 4) { bump(report.blank, subtype); continue; }
    const r: Box = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
    const bbox = (nums(ctx, ap.dict.get(N('BBox'))) ?? [0, 0, r[2] - r[0], r[3] - r[1]]) as Box;
    const m = (nums(ctx, ap.dict.get(N('Matrix'))) ?? [1, 0, 0, 1, 0, 0]) as Matrix;
    const t = transformedBox(bbox, m);
    const w = t[2] - t[0], h = t[3] - t[1];
    if (w <= 0 || h <= 0 || r[2] - r[0] <= 0 || r[3] - r[1] <= 0) { bump(report.blank, subtype); continue; } // nothing visible (an empty signature box)
    ap.dict.set(N('Type'), N('XObject'));
    ap.dict.set(N('Subtype'), N('Form'));
    if (!ap.dict.get(N('Resources')) && dr) ap.dict.set(N('Resources'), dr); // appearances that draw from the form's /DR
    const xref = apRef instanceof PDFRef ? apRef : ctx.register(ap);
    const xname = freeName();
    added.push([xname, xref]);
    const sx = (r[2] - r[0]) / w, sy = (r[3] - r[1]) / h;
    ops.push(`q ${fmt(sx)} 0 0 ${fmt(sy)} ${fmt(r[0] - sx * t[0])} ${fmt(r[1] - sy * t[1])} cm /${xname} Do Q`);
    bump(report.flattened, subtype);
  }

  if (ops.length) {
    // The leaf gets its own copy of the effective resources: inherited ones
    // may be shared with other pages.
    const own = ctx.obj({}) as PDFDict;
    for (const [k, v] of res.entries()) own.set(k, v);
    const xo = ctx.obj({}) as PDFDict;
    if (old instanceof PDFDict) for (const [k, v] of old.entries()) xo.set(k, v);
    for (const [n, r] of added) xo.set(N(n), r);
    own.set(N('XObject'), xo);
    node.set(N('Resources'), own);
    const c = node.get(N('Contents'));
    const parts = c instanceof PDFArray ? c.asArray() : look(ctx, c) instanceof PDFArray ? (look(ctx, c) as PDFArray).asArray() : c ? [c] : [];
    node.set(N('Contents'), ctx.obj([ctx.register(ctx.flateStream('q\n')), ...parts, ctx.register(ctx.flateStream(`\nQ\n${ops.join('\n')}\n`))]));
  }
  if (keep.length) node.set(N('Annots'), ctx.obj(keep));
  else node.delete(N('Annots'));
  return report;
}
