// PageForge's six functions, from bytes to bytes. The worker calls these; so do
// the tests, in Node. Nothing here touches the network or the DOM: compression
// receives its image codec from whoever calls it.
import { zipSync } from 'fflate';
import { clean, type CleanReport } from './clean';
import { compress, type CompressReport, type ImageCodec, type Level, type Progress } from './compress';
import { collectGarbage, dedupeStreams } from './dedupe';
import { imagesToPdf, type ImagesReport, type Paper } from './images';
import { openPdf, type Encryption, type Opened } from './open';
import { assemble, groupLabel, parseRanges, type TidyReport } from './structure';

export interface Source { bytes: Uint8Array; password?: string }

/** Which input failed, and why: the interface asks for that file's password. */
export class SourceError extends Error {
  constructor(readonly index: number, readonly cause: unknown) {
    super(String((cause as Error)?.message ?? cause));
  }
}

async function openAll(sources: Source[]): Promise<Opened[]> {
  const out: Opened[] = [];
  for (const [i, s] of sources.entries()) {
    try { out.push(await openPdf(s.bytes, s.password)); } catch (e) { throw new SourceError(i, e); }
  }
  return out;
}

/** What the result says about the inputs' encryption: restrictions do not survive a new document. */
const restrictions = (opened: Opened[]): Encryption[] => opened.map((o) => o.encryption);

export interface StructureReport extends TidyReport { pages: number; duplicates: number; encryption: Encryption[] }

async function finish(doc: Awaited<ReturnType<typeof assemble>>, encryption: Encryption[]) {
  const duplicates = await dedupeStreams(doc.doc);
  await collectGarbage(doc.doc);
  const bytes = await doc.doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
  const report: StructureReport = { ...doc.tidy, pages: doc.doc.getPageCount(), duplicates, encryption };
  return { bytes, report };
}

export async function mergeFiles(sources: Source[]) {
  const opened = await openAll(sources);
  const picks = opened.flatMap((o, s) => o.doc.getPageIndices().map((page) => ({ source: s, page })));
  return finish(await assemble(opened.map((o) => o.doc), picks), restrictions(opened));
}

export async function organizeFile(source: Source, pages: { page: number; rotate: number }[]) {
  const [o] = await openAll([source]);
  if (!pages.length) throw new Error('no pages left');
  for (const p of pages) if (p.page < 0 || p.page >= o.pages) throw new Error(`page ${p.page + 1} does not exist`);
  return finish(await assemble([o.doc], pages.map((p) => ({ source: 0, page: p.page, rotate: p.rotate }))), restrictions([o]));
}

export type SplitMode = 'extract' | 'ranges' | 'every';
export interface SplitReport { files: { name: string; pages: number }[]; encryption: Encryption[]; zipped: boolean }

/** Extract: the chosen pages in one PDF. Ranges: one PDF per range. Every: one per page. Several files come in a zip. */
export async function splitFile(source: Source, mode: SplitMode, ranges: string, base: string) {
  const [o] = await openAll([source]);
  const groups = mode === 'every' ? o.doc.getPageIndices().map((p) => [p]) : parseRanges(ranges, o.pages);
  const parts = mode === 'extract' ? [groups.flat()] : groups;
  const files: { name: string; bytes: Uint8Array; pages: number }[] = [];
  const names = new Set<string>();
  for (const g of parts) {
    const { bytes, report } = await finish(await assemble([o.doc], g.map((page) => ({ source: 0, page }))), []);
    // The same range twice is two files: a zip keeps one per name.
    const stem = `${base}-${groupLabel(g)}`;
    let name = `${stem}.pdf`;
    for (let k = 2; names.has(name); k++) name = `${stem} (${k}).pdf`;
    names.add(name);
    files.push({ name, bytes, pages: report.pages });
  }
  const report: SplitReport = { files: files.map(({ name, pages }) => ({ name, pages })), encryption: [o.encryption], zipped: files.length > 1 };
  if (files.length === 1) return { bytes: files[0].bytes, name: files[0].name, report };
  // PDFs are compressed already: the zip only stores them.
  const zip = zipSync(Object.fromEntries(files.map((f) => [f.name, [f.bytes, { level: 0 }]])), { mtime: new Date('2000-01-01T00:00:00Z') });
  return { bytes: zip, name: `${base}-split.zip`, report };
}

export async function imagesFile(images: Uint8Array[], paper: Paper): Promise<{ bytes: Uint8Array; report: ImagesReport }> {
  return imagesToPdf(images, paper);
}

export async function compressFile<S>(source: Source, level: Level, codec: ImageCodec<S> | null, progress?: Progress):
Promise<{ bytes: Uint8Array; report: CompressReport & { encryption: Encryption } }> {
  const [o] = await openAll([source]);
  const r = await compress(o.doc, source.bytes, level, codec, progress);
  return { bytes: r.bytes, report: { ...r.report, encryption: o.encryption } };
}

export async function cleanFile(source: Source): Promise<{ bytes: Uint8Array; report: CleanReport & { encryption: Encryption } }> {
  const [o] = await openAll([source]);
  const r = await clean(o.doc, source.bytes);
  return { bytes: r.bytes, report: { ...r.report, encryption: o.encryption } };
}
