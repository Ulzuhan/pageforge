// PageForge's functions, in Node: merge, organize, split, images to PDF, clean.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef } from '@cantoo/pdf-lib';
import {
  cleanFile, imagesFile, interpretPage, mergeFiles, organizeFile, parseRanges, residue, splitFile, UnsupportedImage, SourceError,
  PasswordRequired, orientationMatrix,
} from '@pdf-core';
import { MARKERS, cleanSamplePdf, everything, labelledPdf, photoJpeg, photoPng, quadrantJpeg } from '../../../scripts/fixtures.mjs';
import { mad, render } from './node-codec';

const fixture = (f: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const load = (b: Uint8Array) => PDFDocument.load(b, { updateMetadata: false });
const widths = async (b: Uint8Array) => (await load(b)).getPages().map((p) => Math.round(p.getWidth()));
const textOf = (doc: PDFDocument, i: number) => interpretPage(doc, doc.getPage(i).node).glyphs.map((g) => g.uni ?? '').join('');

describe('page ranges', () => {
  it('reads what people write', () => {
    expect(parseRanges('1-3, 7', 10)).toEqual([[0, 1, 2], [6]]);
    expect(parseRanges(' 9- ; -2 ', 10)).toEqual([[8, 9], [0, 1]]);
    expect(parseRanges('4–5', 10)).toEqual([[3, 4]]);
  });
  it.each([['', /Write the pages/], ['0', /outside/], ['11', /outside/], ['5-3', /backwards/], ['a', /not a page/], ['1--2', /not a page/]])(
    'explains «%s»', (text, msg) => { expect(() => parseRanges(text, 10)).toThrow(msg); });
});

describe('merge', () => {
  it('keeps the order of files and pages, stores identical streams once, and says nothing about itself', async () => {
    const a = await labelledPdf(['A1', 'A2']);
    const b = await labelledPdf(['B1'], { sizes: [[600, 700]] });
    const { bytes, report } = await mergeFiles([{ bytes: b }, { bytes: a }, { bytes: a }]);
    expect(await widths(bytes)).toEqual([600, 500, 501, 500, 501]);
    expect(report.pages).toBe(5);
    expect(report.duplicates).toBeGreaterThan(0); // the same file twice: its content streams are stored once
    const doc = await load(bytes);
    expect(doc.context.trailerInfo.Info).toBeUndefined();
    expect(textOf(doc, 3)).toBe('A1');
  });

  it('asks for the password of the file that needs one, and only that one', async () => {
    const err = await mergeFiles([{ bytes: fixture('libreoffice-letter.pdf') }, { bytes: fixture('aes128-user-password.pdf') }]).catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.index).toBe(1);
    expect(err.cause).toBeInstanceOf(PasswordRequired);
    const ok = await mergeFiles([{ bytes: fixture('libreoffice-letter.pdf') }, { bytes: fixture('aes128-user-password.pdf'), password: 'abrir' }]);
    expect(ok.report.encryption).toEqual(['none', 'user-password']);
    expect((await load(ok.bytes)).getPageCount()).toBe(2);
  });
});

describe('organize', () => {
  it('reorders, rotates and deletes', async () => {
    const src = await labelledPdf(['P1', 'P2', 'P3']);
    const { bytes } = await organizeFile({ bytes: src }, [{ page: 2, rotate: 0 }, { page: 0, rotate: 90 }]);
    const doc = await load(bytes);
    expect(await widths(bytes)).toEqual([502, 500]);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([0, 90]);
    expect([textOf(doc, 0), textOf(doc, 1)]).toEqual(['P3', 'P1']);
  });

  it('adds to a page’s own rotation and allows a page twice', async () => {
    const src = await labelledPdf(['P1']);
    const turned = await organizeFile({ bytes: src }, [{ page: 0, rotate: 270 }]);
    const again = await organizeFile({ bytes: turned.bytes }, [{ page: 0, rotate: 180 }, { page: 0, rotate: 0 }]);
    expect((await load(again.bytes)).getPages().map((p) => p.getRotation().angle)).toEqual([90, 270]);
  });

  it('keeps a link between pages that came along, drops one whose page did not, and removes code', async () => {
    const src = await labelledPdf(['P1', 'P2'], { link: true, risky: true });
    const both = await organizeFile({ bytes: src }, [{ page: 1, rotate: 0 }, { page: 0, rotate: 0 }]);
    const doc = await load(both.bytes);
    const annots = (doc.getPage(1).node.lookup(PDFName.of('Annots')) as PDFArray).asArray().map((r) => doc.context.lookup(r) as PDFDict);
    const dest = annots.map((a) => a.lookup(PDFName.of('Dest'))).find(Boolean) as PDFArray;
    expect(String(dest.get(0))).toBe(String(doc.getPage(0).ref)); // P2 is now first, and the link still reaches it
    expect(both.report.actionsRemoved).toBe(2);
    expect(await everything(both.bytes)).not.toContain(MARKERS.js);

    const alone = await organizeFile({ bytes: src }, [{ page: 0, rotate: 0 }]);
    expect(alone.report.linksRemoved).toBe(2); // the page link, and the JavaScript one left with nothing to do
    const left = (await load(alone.bytes)).getPage(0).node.lookup(PDFName.of('Annots')) as PDFArray;
    expect(left.size()).toBe(1); // the web link stays
  });
});

describe('split', () => {
  const base = 'doc';
  it('extracts pages into one file', async () => {
    const src = await labelledPdf(['P1', 'P2', 'P3', 'P4']);
    const r = await splitFile({ bytes: src }, 'extract', '4, 1-2', base);
    expect(r.name).toBe('doc-pages-4_1_2.pdf');
    expect(await widths(r.bytes)).toEqual([503, 500, 501]);
  });

  it('makes one file per range, in a zip that only stores', async () => {
    const src = await labelledPdf(['P1', 'P2', 'P3', 'P4']);
    const r = await splitFile({ bytes: src }, 'ranges', '1-2, 4', base);
    expect(r.name).toBe('doc-split.zip');
    const files = unzipSync(r.bytes);
    expect(Object.keys(files)).toEqual(['doc-pages-1-2.pdf', 'doc-page-4.pdf']);
    expect(await widths(files['doc-pages-1-2.pdf'])).toEqual([500, 501]);
    expect(await widths(files['doc-page-4.pdf'])).toEqual([503]);
  });

  it('makes one file per page', async () => {
    const r = await splitFile({ bytes: await labelledPdf(['P1', 'P2', 'P3']) }, 'every', '', base);
    expect(r.report.files.map((f) => f.name)).toEqual(['doc-page-1.pdf', 'doc-page-2.pdf', 'doc-page-3.pdf']);
  });
});

describe('images to PDF', () => {
  it('turns a phone photo upright, without its EXIF or GPS', async () => {
    // Stored 400×300 (landscape), orientation 6: it is a portrait photo, rotated by the phone.
    const { bytes, report } = await imagesFile([quadrantJpeg(400, 300, 6)], 'image');
    expect(report).toMatchObject({ pages: 1, turned: 1, gpsRemoved: 1, jpegMetadataRemoved: 1 });
    expect(await widths(bytes)).toEqual([300]);
    const text = await everything(bytes);
    expect(text).not.toContain(MARKERS.exif);
    expect(text).not.toContain('Exif');
    const px = await render(bytes, 0);
    const at = (x: number, y: number) => Array.from(px.data.subarray((y * px.width + x) * 4, (y * px.width + x) * 4 + 3));
    // The stored top-left quarter (red) shows at the top right once upright.
    expect(at(px.width - 40, 40)[0]).toBeGreaterThan(200);
    expect(at(px.width - 40, 40)[1]).toBeLessThan(60);
    expect(at(40, 40)[0]).toBeLessThan(160);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('maps orientation %i onto its box', (o) => {
    const [a, b, c, d, e, f] = orientationMatrix(o, 10, 20, 300, 400);
    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [a * u + c * v + e, b * u + d * v + f]);
    const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([10, 310, 20, 420]);
  });

  it('puts each image on its own page, turning the paper with the picture', async () => {
    const { bytes } = await imagesFile([photoJpeg(800, 600), photoPng(300, 600, { alpha: true })], 'a4');
    const doc = await load(bytes);
    expect(doc.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())])).toEqual([[842, 595], [595, 842]]);
    const hasSMask = doc.context.enumerateIndirectObjects().some(([, o]) => o instanceof PDFRawStream && o.dict.has(PDFName.of('SMask')));
    expect(hasSMask).toBe(true);
    const letter = await imagesFile([photoJpeg(600, 800)], 'letter');
    expect(await widths(letter.bytes)).toEqual([612]);
  });

  it('says which file is not an image it knows', async () => {
    const err = await imagesFile([photoJpeg(40, 40), new TextEncoder().encode('GIF89a')], 'a4').catch((e) => e);
    expect(err).toBeInstanceOf(UnsupportedImage);
    expect(err.index).toBe(1);
  });
});

describe('clean', () => {
  it('finds everything, removes it, keeps what the page shows, and checks the result', async () => {
    const input = await cleanSamplePdf();
    const { bytes, report } = await cleanFile({ bytes: input });
    expect(report.found).toMatchObject({ attachments: 1, openAction: true, formFields: 2, bookmarks: true, earlierVersions: 1 });
    expect(report.found.info).toEqual(expect.arrayContaining(['Title', 'Producer']));
    expect(report.found.xmp).toBeGreaterThan(0);
    expect(report.found.javascript).toBeGreaterThan(0);
    expect(report.jpeg).toMatchObject({ images: 1, cleaned: 1, exif: 1, gps: 1, xmp: 1 });
    expect(report.annotations.flattened).toMatchObject({ Widget: 2, FreeText: 1 });
    expect(report.annotations.dropped).toMatchObject({ FreeText: 1 }); // the hidden one
    expect(report.annotations.removed).toMatchObject({ Link: 1 });

    const doc = await load(bytes);
    expect(residue(doc)).toEqual([]);
    const all = await everything(bytes);
    for (const m of [MARKERS.exif, MARKERS.comment, MARKERS.xmp, MARKERS.author, MARKERS.attachment, MARKERS.js, MARKERS.piece, MARKERS.hidden, 'Second title']) {
      expect(all, m).not.toContain(m);
    }
    const text = textOf(doc, 0);
    expect(text).toContain(MARKERS.field);
    expect(text).toContain(MARKERS.note);
    expect(text).toContain('Visible page text');
    // What the page showed, it still shows: annotations drawn by pdf.js before, flattened after.
    expect(mad(await render(input, 0), await render(bytes, 0))).toBeLessThan(0.5);
  });

  it('cleans a note left by Preview, keeping it on the page', async () => {
    const { bytes, report } = await cleanFile({ bytes: fixture('freetext-note.pdf') });
    expect(Object.values(report.annotations.flattened).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(residue(await load(bytes))).toEqual([]);
  });

  it('opens an owner-password file and says so', async () => {
    const { report } = await cleanFile({ bytes: fixture('aes256-owner-only.pdf') });
    expect(report.encryption).toBe('owner-password-only');
  });

  it('is a new document: an earlier object nobody draws does not come along', async () => {
    const src = await labelledPdf(['P1']);
    const doc = await load(src);
    doc.context.register(doc.context.obj({ Secret: 'Orphan' }));
    const withOrphan = await doc.save();
    const { bytes } = await cleanFile({ bytes: withOrphan });
    expect(await everything(bytes)).not.toContain('Orphan');
    expect((await load(bytes)).context.enumerateIndirectObjects().every(([r]) => r instanceof PDFRef)).toBe(true);
  });
});
