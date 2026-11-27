// Clean (plan §4): what a PDF carries besides its pages, found, reported and
// removed. Always through the sanitized copy, never «load and save»: a PDF
// saved incrementally keeps what was deleted in earlier versions (spike, P4).
//
// Steps:
//  1. survey what is there (metadata, XMP, attachments, JavaScript, opening
//     action, form fields, bookmarks, tags, earlier versions);
//  2. draw visible annotations into the page, so that a filled form or a note
//     does not vanish with the annotations;
//  3. strip EXIF, GPS, XMP and comments from every embedded JPEG, at the byte
//     level, pixels untouched (spike, P5);
//  4. the sanitized copy, and one last sweep of private keys anywhere in it;
//  5. check the saved result again (residue) before handing it over.
import { PDFArray, PDFDict, PDFDocument, PDFRawStream, PDFStream } from '@cantoo/pdf-lib';
import { flattenAnnotations, type FlattenReport } from './flatten';
import { readExif, stripJpeg } from './jpeg';
import { N, filters, get, look, name, walk } from './objects';
import { residue, sanitizedCopy, XOBJECT_KEYS } from './sanitize';

export interface CleanReport {
  found: {
    /** Document-information fields that had a value: Title, Author, Producer… */
    info: string[];
    xmp: number;
    attachments: number;
    javascript: number;
    openAction: boolean;
    formFields: number;
    bookmarks: boolean;
    tags: boolean;
    /** Times the file was saved on top of itself; each kept the previous version inside. */
    earlierVersions: number;
  };
  annotations: FlattenReport & { removed: Record<string, number> };
  jpeg: { images: number; cleaned: number; exif: number; gps: number; xmp: number; other: number; bytes: number };
  privateKeys: number;
  unusedResources: number;
  before: number;
  after: number;
}

const latin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};

function survey(doc: PDFDocument, bytes: Uint8Array): CleanReport['found'] {
  const ctx = doc.context;
  const info = look(ctx, ctx.trailerInfo.Info as never);
  const infoKeys = info instanceof PDFDict
    ? info.entries().filter(([, v]) => String(look(ctx, v) ?? '').replace(/^[(<]|[)>]$/g, '').trim() !== '').map(([k]) => k.decodeText())
    : [];
  let xmp = 0, attachments = 0, javascript = 0;
  walk(ctx, (o) => {
    if (o instanceof PDFStream) {
      const type = name(get(ctx, o, 'Type'));
      if (type === 'Metadata') xmp++;
      if (type === 'EmbeddedFile') attachments++;
    } else if (o instanceof PDFDict && o.has(N('JS'))) javascript++;
  });
  const fields = look(ctx, get(ctx, get(ctx, doc.catalog, 'AcroForm') as PDFDict | undefined, 'Fields'));
  const text = latin1(bytes);
  const eofs = (text.match(/%%EOF/g) ?? []).length;
  const linearized = /\/Linearized/.test(text.slice(0, 2048));
  return {
    info: infoKeys,
    xmp,
    attachments,
    javascript,
    openAction: doc.catalog.has(N('OpenAction')),
    formFields: fields instanceof PDFArray ? fields.size() : 0,
    bookmarks: doc.catalog.has(N('Outlines')),
    tags: doc.catalog.has(N('StructTreeRoot')),
    earlierVersions: Math.max(0, eofs - 1 - (linearized ? 1 : 0)),
  };
}

function cleanJpegs(doc: PDFDocument, report: CleanReport['jpeg']) {
  const ctx = doc.context;
  for (const [ref, s] of ctx.enumerateIndirectObjects()) {
    if (!(s instanceof PDFRawStream) || name(look(ctx, s.dict.get(N('Subtype')))) !== 'Image') continue;
    const f = filters(ctx, s);
    if (f.length !== 1 || f[0] !== 'DCTDecode') continue;
    report.images++;
    let stripped;
    try { stripped = stripJpeg(s.contents); } catch { continue; } // a JPEG we cannot walk is left alone; residue still checks it
    if (!stripped.removed.length) continue;
    if (readExif(s.contents).gps) report.gps++;
    for (const r of stripped.removed) {
      if (r.marker === 'APP1' && r.id.startsWith('Exif')) report.exif++;
      else if (r.marker === 'APP1' && r.id.startsWith('http://ns.adobe.com/xap')) report.xmp++;
      else report.other++;
    }
    report.bytes += s.contents.length - stripped.bytes.length;
    report.cleaned++;
    const nd = s.dict.clone(ctx);
    nd.delete(N('Length'));
    ctx.assign(ref, PDFRawStream.of(nd, stripped.bytes));
  }
}

export async function clean(doc: PDFDocument, input: Uint8Array): Promise<{ bytes: Uint8Array; report: CleanReport }> {
  const ctx = doc.context;
  const report: CleanReport = {
    found: survey(doc, input),
    annotations: { flattened: {}, dropped: {}, removed: {} },
    jpeg: { images: 0, cleaned: 0, exif: 0, gps: 0, xmp: 0, other: 0, bytes: 0 },
    privateKeys: 0, unusedResources: 0, before: input.length, after: 0,
  };

  for (const page of doc.getPages()) {
    flattenAnnotations(doc, page, report.annotations);
    // What is left (links, pop-ups) goes with the sanitized copy; it is counted here.
    const left = look(ctx, page.node.get(N('Annots')));
    if (left instanceof PDFArray) for (const a of left.asArray()) {
      const st = name(get(ctx, look(ctx, a) as PDFDict | undefined, 'Subtype')) ?? 'Unknown';
      report.annotations.removed[st] = (report.annotations.removed[st] ?? 0) + 1;
    }
  }
  cleanJpegs(doc, report.jpeg);

  const { doc: out, report: scrub } = await sanitizedCopy(doc);
  report.unusedResources = scrub.xobjectsRemoved + scrub.patternsRemoved;
  report.privateKeys = scrub.keysRemoved;
  for (const [, o] of out.context.enumerateIndirectObjects()) {
    const d = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : undefined;
    if (!d) continue;
    for (const k of XOBJECT_KEYS) if (d.has(N(k))) { d.delete(N(k)); report.privateKeys++; }
  }
  const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });

  const check = await PDFDocument.load(bytes, { updateMetadata: false });
  const left = residue(check);
  for (const [, s] of check.context.enumerateIndirectObjects()) {
    if (!(s instanceof PDFRawStream) || filters(check.context, s).join() !== 'DCTDecode') continue;
    try { if (stripJpeg(s.contents).removed.length) left.push('JPEG metadata'); } catch { /* not walkable; nothing found either */ }
  }
  if (left.length) throw new Error(`the cleaned copy still has: ${[...new Set(left)].join(', ')}`);
  report.after = bytes.length;
  return { bytes, report };
}
