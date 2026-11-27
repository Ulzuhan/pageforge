// Identical streams stored once (merging the same logo or font from several
// files), and objects nothing points to left out before saving.
import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, PDFStream, type PDFDocument, type PDFObject } from '@cantoo/pdf-lib';

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

/** Merges streams with the same dictionary (Length aside) and the same bytes. Returns how many went. */
export async function dedupeStreams(doc: PDFDocument): Promise<number> {
  const ctx = doc.context;
  const enc = new TextEncoder();
  let total = 0;
  // A second pass catches what the first made identical (two font
  // dictionaries that now point at the same font file).
  for (let pass = 0; pass < 4; pass++) {
    const seen = new Map<string, PDFRef>();
    const remap = new Map<string, PDFRef>();
    for (const [ref, s] of ctx.enumerateIndirectObjects()) {
      if (!(s instanceof PDFRawStream)) continue;
      const dict = s.dict.entries().filter(([k]) => k !== PDFName.of('Length')).map(([k, v]) => `${k} ${v}`).sort().join('\n');
      const head = enc.encode(`${dict}\n${s.contents.length}\n`);
      const buf = new Uint8Array(head.length + s.contents.length);
      buf.set(head);
      buf.set(s.contents, head.length);
      const key = hex(await crypto.subtle.digest('SHA-256', buf));
      const first = seen.get(key);
      if (first) remap.set(String(ref), first);
      else seen.set(key, ref);
    }
    if (!remap.size) break;
    const fix = (o: PDFObject) => {
      if (o instanceof PDFDict) {
        for (const [k, v] of o.entries()) {
          if (v instanceof PDFRef && remap.has(String(v))) o.set(k, remap.get(String(v))!);
          else fix(v);
        }
      } else if (o instanceof PDFArray) {
        for (let i = 0; i < o.size(); i++) {
          const v = o.get(i);
          if (v instanceof PDFRef && remap.has(String(v))) o.set(i, remap.get(String(v))!);
          else fix(v);
        }
      } else if (o instanceof PDFStream) fix(o.dict);
    };
    for (const [, o] of ctx.enumerateIndirectObjects()) fix(o);
    for (const [ref] of ctx.enumerateIndirectObjects()) if (remap.has(String(ref))) ctx.delete(ref);
    total += remap.size;
  }
  return total;
}

/** Deletes every object the trailer does not reach. Returns how many. */
export async function collectGarbage(doc: PDFDocument): Promise<number> {
  await doc.flush(); // pending fonts and images get their objects first
  const ctx = doc.context;
  const live = new Set<string>();
  const mark = (o: PDFObject | undefined) => {
    if (o instanceof PDFRef) {
      const k = String(o);
      if (live.has(k)) return;
      live.add(k);
      mark(ctx.lookup(o));
    } else if (o instanceof PDFDict) for (const [, v] of o.entries()) mark(v);
    else if (o instanceof PDFArray) for (const v of o.asArray()) mark(v);
    else if (o instanceof PDFStream) mark(o.dict);
  };
  const t = ctx.trailerInfo;
  for (const o of [t.Root, t.Info, t.Encrypt]) mark(o as PDFObject | undefined);
  let n = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!live.has(String(ref))) { ctx.delete(ref); n++; }
  return n;
}
