// Merge, organize, split: every one builds a NEW document from pages, never
// «load and save» (spike, P4). What comes along is what the pages carry: their
// content, resources and annotations. Bookmarks, form logic, the structure
// tree, attachments and the document's metadata stay behind.
//
// Pages are copied by reference with one object copier per source, so a link
// from one copied page to another lands on the copy (pdf-lib's copyPages copies
// the page node itself, and a link's target became a second, orphan copy).
// Pages that are not picked are mapped to a reference that resolves to
// nothing, so the copier does not walk into them through links.
//
// Two tidy-ups on the way out:
//  - links whose target page did not come along (or a named destination,
//    which lived in the catalog) are removed: they would point nowhere;
//  - actions that run code or other programs (JavaScript, Launch, forms that
//    submit somewhere) are removed, from pages and from annotations, also
//    when they are chained after a harmless one (/Next);
//  - form widgets let go of the field tree (/Parent), which would otherwise
//    bring along the fields, values and scripts of every page.
import { PDFArray, PDFDict, PDFDocument, PDFObjectCopier, PDFPage, PDFPageLeaf, PDFRef, degrees, type PDFObject } from '@cantoo/pdf-lib';
import { N, get, look, name } from './objects';

export interface PagePick {
  /** Index into the sources. */
  source: number;
  /** 0-based page index in that source. */
  page: number;
  /** Clockwise, added to the page's own rotation. */
  rotate?: number;
}

const RISKY_ACTIONS = new Set(['JavaScript', 'Launch', 'ImportData', 'SubmitForm', 'ResetForm', 'Rendition', 'Movie', 'Sound', 'Hide']);

export interface TidyReport { linksRemoved: number; actionsRemoved: number }

export async function assemble(sources: PDFDocument[], picks: PagePick[]): Promise<{ doc: PDFDocument; tidy: TidyReport }> {
  const out = await PDFDocument.create({ updateMetadata: false });
  const nowhere = out.context.nextRef(); // never assigned: looks up to nothing
  const copiers = sources.map((src, s) => {
    const copier = PDFObjectCopier.for(src.context, out.context);
    const picked = new Set(picks.filter((p) => p.source === s).map((p) => p.page));
    const seen = (copier as unknown as { traversedObjects?: Map<PDFObject, PDFObject> }).traversedObjects;
    if (seen instanceof Map) src.getPages().forEach((pg, i) => { if (!picked.has(i)) seen.set(pg.ref, nowhere); });
    return copier;
  });
  const used = new Set<string>();
  for (const p of picks) {
    const src = sources[p.source].getPage(p.page);
    const key = `${p.source}:${p.page}`;
    let ref: PDFRef, node: PDFPageLeaf;
    if (!used.has(key)) {
      // The first time, by reference: links from other pages find this copy.
      ref = copiers[p.source].copy(src.ref);
      const copied = out.context.lookup(ref);
      if (!(copied instanceof PDFPageLeaf)) throw new Error(`page ${p.page + 1} could not be copied`);
      node = copied;
      used.add(key);
    } else {
      // Again: a new page object that shares the copied resources.
      node = copiers[p.source].copy(src.node);
      ref = out.context.register(node);
    }
    const page = out.addPage(PDFPage.of(node, ref, out));
    const turn = ((p.rotate ?? 0) % 360 + 360) % 360;
    if (turn) page.setRotation(degrees((page.getRotation().angle + turn) % 360));
  }
  return { doc: out, tidy: tidy(out) };
}

function tidy(doc: PDFDocument): TidyReport {
  const ctx = doc.context;
  const report: TidyReport = { linksRemoved: 0, actionsRemoved: 0 };
  const inTree = new Set(doc.getPages().map((p) => String(p.ref)));

  const risky = (a: PDFObject | undefined) => {
    const d = look(ctx, a);
    return d instanceof PDFDict && RISKY_ACTIONS.has(name(get(ctx, d, 'S')) ?? '');
  };
  // An action may run others after it (/Next: one, or an array). The risky
  // ones go, with whatever they would have run next.
  const seenActions = new Set<PDFObject>();
  const pruneNext = (action: PDFDict, depth = 0) => {
    if (seenActions.has(action)) return;
    seenActions.add(action);
    const next = look(ctx, action.get(N('Next')));
    if (next === undefined) return;
    if (depth > 32) { action.delete(N('Next')); report.actionsRemoved++; return; }
    const list = next instanceof PDFArray ? next.asArray() : [action.get(N('Next'))!];
    const keep: PDFObject[] = [];
    for (const item of list) {
      const a = look(ctx, item);
      if (!(a instanceof PDFDict)) continue;
      if (risky(a)) { report.actionsRemoved++; continue; }
      pruneNext(a, depth + 1);
      keep.push(item);
    }
    if (!keep.length) action.delete(N('Next'));
    else if (keep.length !== list.length || next instanceof PDFArray) action.set(N('Next'), keep.length === 1 ? keep[0] : ctx.obj(keep));
  };
  const deadDest = (d: PDFObject | undefined): boolean => {
    const dest = look(ctx, d);
    if (dest instanceof PDFArray) {
      const target = dest.get(0);
      return target instanceof PDFRef ? !inTree.has(String(target)) : false; // a number targets a page in another file
    }
    return dest !== undefined; // a named destination: the catalog that resolved it is not copied
  };

  for (const page of doc.getPages()) {
    const node = page.node;
    if (node.has(N('AA'))) { node.delete(N('AA')); report.actionsRemoved++; }
    node.delete(N('StructParents'));
    const annots = look(ctx, node.get(N('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    const keep: PDFObject[] = [];
    for (const ref of annots.asArray()) {
      const a = look(ctx, ref);
      if (!(a instanceof PDFDict)) continue;
      a.delete(N('StructParent'));
      if (a.has(N('P'))) a.set(N('P'), page.ref); // its page, which may be a new one
      if (a.has(N('AA'))) { a.delete(N('AA')); report.actionsRemoved++; }
      // A form field's widget hangs from the field tree (/Parent), and the tree
      // reaches every widget of every page through /Kids, values included. The
      // form does not come along (no /AcroForm), so the widget lets go of it:
      // what it shows is in its own appearance, and the pages that were left
      // out stay out, scripts in their fields too.
      if (name(get(ctx, a, 'Subtype')) === 'Widget') a.delete(N('Parent'));
      const action = look(ctx, a.get(N('A')));
      if (risky(action)) { a.delete(N('A')); report.actionsRemoved++; }
      else if (action instanceof PDFDict) pruneNext(action);
      if (name(get(ctx, a, 'Subtype')) === 'Link') {
        const act = look(ctx, a.get(N('A')));
        const goTo = act instanceof PDFDict && name(get(ctx, act, 'S')) === 'GoTo';
        if (deadDest(a.get(N('Dest'))) || (goTo && deadDest((act as PDFDict).get(N('D'))))) { report.linksRemoved++; continue; }
        if (!a.has(N('A')) && !a.has(N('Dest'))) { report.linksRemoved++; continue; }
      }
      keep.push(ref);
    }
    if (keep.length) node.set(N('Annots'), ctx.obj(keep));
    else node.delete(N('Annots'));
  }
  return report;
}

export { PageRangeError, parseRanges, groupLabel } from './ranges';
