// The sanitized copy: a NEW document holding only what hangs from the pages,
// without annotations, forms, metadata, attachments, JavaScript, outlines or
// structure tree. It is PageForge's «Clean» and the last step of every InkBar
// redaction. Never «load and save»: with pdf-lib that keeps everything,
// including an old incremental revision (spike, P4).
//
// Before copying, two more cleanups the public-PDF tests found (spike, P9):
//  1. Resources the content does not paint go. Surgery gives each modified use
//     of a Form XObject its own copy under a new name; the original stayed in
//     /Resources under the old one. Invisible, but extractable. And what nobody
//     paints, nobody has reviewed.
//  2. Private metadata goes from XObjects too, not only from pages: /PieceInfo
//     (Illustrator keeps the whole source document there, author included),
//     /Metadata (XMP) and what pdfTeX leaves when it includes a figure
//     (PTEX.InfoDict with the figure's Info, PTEX.FileName with its path).
import { PDFDict, PDFDocument, PDFName, PDFStream, type PDFContext, type PDFObject } from '@cantoo/pdf-lib';
import { get, look, name, num, pageContent, pageResources, streamBytes, walk, N } from './objects';
import { tokenize } from './tokenize';

export const PAGE_KEYS = ['Annots', 'AA', 'Metadata', 'PieceInfo', 'StructParents', 'Thumb', 'B', 'Tabs'];
export const XOBJECT_KEYS = ['PieceInfo', 'Metadata', 'LastModified', 'PTEX.InfoDict', 'PTEX.FileName', 'PTEX.PageNumber', 'OPI',
  'StructParent', 'StructParents', 'Thumb'];

export interface ScrubReport { xobjectsRemoved: number; patternsRemoved: number; keysRemoved: number }

type Used = { XObject: Set<string>; Pattern: Set<string> };

/** Removes unused XObjects/Patterns and private metadata from what the pages reference. Mutates doc. */
export function scrubResources(doc: PDFDocument): ScrubReport {
  const ctx: PDFContext = doc.context;
  const report: ScrubReport = { xobjectsRemoved: 0, patternsRemoved: 0, keysRemoved: 0 };
  const done = new Set<string>();
  const isForm = (x: PDFObject | undefined): x is PDFStream => x instanceof PDFStream && name(get(ctx, x, 'Subtype')) === 'Form';

  // Names a content stream uses. A Form without its own /Resources draws from
  // its caller's, so its names count for the caller.
  const used = (bytes: Uint8Array, res: PDFDict, acc: Used = { XObject: new Set(), Pattern: new Set() }, depth = 0): Used => {
    let ops: ReturnType<typeof tokenize> = [];
    try { ops = tokenize(bytes); } catch { /* unreadable content keeps nothing alive */ }
    for (const o of ops) {
      const first = o.operands[0];
      if (o.op === 'Do' && first?.t === 'name') {
        acc.XObject.add(first.v);
        const xd = get(ctx, res, 'XObject');
        const x = xd instanceof PDFDict ? look(ctx, xd.get(N(first.v))) : undefined;
        if (isForm(x) && !x.dict.get(N('Resources')) && depth < 12) used(streamBytes(ctx, x), res, acc, depth + 1);
      }
      if ((o.op === 'scn' || o.op === 'SCN') && o.operands.length) {
        const last = o.operands[o.operands.length - 1];
        if (last.t === 'name') acc.Pattern.add(last.v);
      }
    }
    return acc;
  };

  const scrubKeys = (d: PDFDict) => {
    for (const k of XOBJECT_KEYS) if (d.has(N(k))) { d.delete(N(k)); report.keysRemoved++; }
  };

  const prune = (res: PDFDict, u: Used): PDFDict => {
    const out = ctx.obj({}) as PDFDict;
    for (const [k, v] of res.entries()) out.set(k, v);
    for (const cat of ['XObject', 'Pattern'] as const) {
      const old = get(ctx, res, cat);
      if (!(old instanceof PDFDict)) continue;
      const kept = ctx.obj({}) as PDFDict;
      for (const [k, v] of old.entries()) {
        if (!u[cat].has(k.decodeText())) {
          if (cat === 'XObject') report.xobjectsRemoved++; else report.patternsRemoved++;
          continue;
        }
        kept.set(k, v);
        visit(v);
      }
      out.set(N(cat), kept);
    }
    return out;
  };

  const visit = (ref: PDFObject) => {
    const key = String(ref);
    if (done.has(key)) return;
    done.add(key);
    const x = look(ctx, ref);
    if (!(x instanceof PDFStream) && !(x instanceof PDFDict)) return;
    const d = x instanceof PDFStream ? x.dict : x;
    scrubKeys(d);
    const smask = look(ctx, d.get(N('SMask')));
    if (smask instanceof PDFStream) scrubKeys(smask.dict);
    const tiling = num(get(ctx, d, 'PatternType')) === 1;
    if (x instanceof PDFStream && (isForm(x) || tiling)) {
      const res = get(ctx, x, 'Resources');
      if (res instanceof PDFDict) x.dict.set(N('Resources'), prune(res, used(streamBytes(ctx, x), res)));
    }
  };

  for (const p of doc.getPages()) {
    const res = pageResources(ctx, p.node);
    p.node.set(N('Resources'), prune(res, used(pageContent(ctx, p.node), res)));
  }
  return report;
}

/** A new document with the given (or all) pages, sanitized. The source is modified. */
export async function sanitizedCopy(src: PDFDocument, pageIndices?: number[]): Promise<{ doc: PDFDocument; report: ScrubReport }> {
  const report = scrubResources(src);
  for (const p of src.getPages()) for (const k of PAGE_KEYS) p.node.delete(PDFName.of(k));
  const out = await PDFDocument.create({ updateMetadata: false });
  const pages = await out.copyPages(src, pageIndices ?? src.getPageIndices());
  for (const p of pages) out.addPage(p);
  return { doc: out, report };
}

/** What a sanitized document must not contain. Used by the tests and, later, by the verification. */
export function residue(doc: PDFDocument): string[] {
  const ctx = doc.context;
  const found: string[] = [];
  for (const k of ['Metadata', 'StructTreeRoot', 'Outlines', 'AcroForm', 'OpenAction', 'AA', 'Names']) {
    if (doc.catalog.has(N(k))) found.push(`catalog /${k}`);
  }
  const info = look(ctx, ctx.trailerInfo.Info as PDFObject | undefined);
  if (info instanceof PDFDict && info.entries().length) found.push('trailer /Info');
  doc.getPages().forEach((p, i) => {
    for (const k of PAGE_KEYS) if (p.node.has(N(k))) found.push(`page ${i} /${k}`);
  });
  walk(ctx, (obj) => {
    const d = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : undefined;
    if (!d) return;
    for (const k of XOBJECT_KEYS) if (d.has(N(k))) found.push(`object /${k}`);
    if (d.has(N('JS')) || d.has(N('JavaScript'))) found.push('object /JS');
    if (name(get(ctx, d, 'S')) === 'JavaScript' || name(get(ctx, d, 'S')) === 'Launch') found.push('action that runs code');
    if (d.has(N('EmbeddedFile')) || name(get(ctx, d, 'Type')) === 'EmbeddedFile' || d.has(N('EF'))) found.push('embedded file');
  });
  return found;
}


