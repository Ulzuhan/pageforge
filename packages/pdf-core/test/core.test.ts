import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFName, PDFString, StandardFonts } from '@cantoo/pdf-lib';
import {
  glyphNameToUnicode, interpretPage, openPdf, parseToUnicode, PasswordRequired, residue, sanitizedCopy,
} from '@pdf-core';

const fixture = (f: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const compact = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').replace(/\s+/g, '');

async function textOf(file: string) {
  const { doc } = await openPdf(fixture(file));
  return doc.getPages().map((p) => interpretPage(doc, p.node));
}

describe('fonts', () => {
  it('maps glyph names the way the Adobe Glyph List does', () => {
    expect(glyphNameToUnicode('fi')).toBe('ﬁ');
    expect(glyphNameToUnicode('alpha')).toBe('α');
    expect(glyphNameToUnicode('uni00E9')).toBe('é');
    expect(glyphNameToUnicode('u1F600')).toBe('😀');
    expect(glyphNameToUnicode('a.sc')).toBe('a');
    expect(glyphNameToUnicode('f_f_i')).toBe('ffi');
    expect(glyphNameToUnicode('parenleftBigg')).toBe('(');
    expect(glyphNameToUnicode('nosuchglyph')).toBeUndefined();
  });

  it('parses bfchar and both bfrange forms', () => {
    const m = parseToUnicode(`beginbfchar <01> <0041> endbfchar
      beginbfrange <10> <12> <0061> <20> <21> [<00E9> <00F1>] endbfrange`);
    expect([m.get(1), m.get(0x11), m.get(0x12), m.get(0x20), m.get(0x21)]).toEqual(['A', 'b', 'c', 'é', 'ñ']);
  });
});

describe('interpreter', () => {
  // The same letter, printed by three producers (spike, P2: 100 % against pdfminer).
  it.each(['libreoffice-letter.pdf', 'chrome-letter.pdf', 'quartz-letter.pdf'])('reads every glyph of %s', async (f) => {
    const [page] = await textOf(f);
    const text = compact(page.glyphs.map((g) => g.uni ?? '�').join(''));
    expect(page.glyphs.length).toBeGreaterThan(100);
    expect(page.glyphs.filter((g) => g.uni === undefined)).toEqual([]);
    for (const v of ['12345678Z', 'ES9121000418450200051332', 'ana.ejemplo@example.com', 'AnaEjemploPrueba']) expect(text).toContain(v);
    for (const g of page.glyphs) {
      expect(g.bbox[0]).toBeGreaterThanOrEqual(0);
      expect(g.bbox[3]).toBeLessThanOrEqual(842);
    }
  });

  it('follows every text operator', async () => {
    const [page] = await textOf('text-operators.pdf');
    expect(compact(page.glyphs.map((g) => g.uni).join(''))).toContain('12345678Z');
    expect(new Set(page.glyphs.map((g) => g.fontSize)).size).toBeGreaterThan(1);
  });

  it('reads Type0 / Identity-H with ToUnicode', async () => {
    const [page] = await textOf('type0-identity-h.pdf');
    expect(page.glyphs.some((g) => g.font.kind === 'Type0' && g.font.ok)).toBe(true);
    expect(compact(page.glyphs.map((g) => g.uni).join(''))).toContain('12345678Z');
  });

  it('sees through a Form XObject shared by two pages', async () => {
    const pages = await textOf('shared-xobject.pdf');
    expect(pages).toHaveLength(2);
    for (const p of pages) {
      expect(p.formUses.length).toBeGreaterThan(0);
      expect(compact(p.glyphs.map((g) => g.uni).join(''))).toContain('12345678Z');
    }
  });

  it.each(['reportlab-invoice.pdf', 'fpdf2-payslip.pdf'])('reads %s (spike P9 producers)', async (f) => {
    const pages = await textOf(f);
    const text = compact(pages.flatMap((p) => p.glyphs.map((g) => g.uni)).join(''));
    expect(text).toContain('12345678Z');
    expect(pages.flatMap((p) => p.glyphs).filter((g) => g.uni === undefined)).toEqual([]);
  });

  it('records paths with their bounding boxes', async () => {
    const [page] = await textOf('reportlab-invoice.pdf');
    expect(page.paths.length).toBeGreaterThan(0);
    expect(page.paths.every((p) => p.bbox[2] >= p.bbox[0] && p.bbox[3] >= p.bbox[1])).toBe(true);
  });
});

describe('opening encrypted PDFs', () => {
  it('opens a PDF with restrictions only, and says so', async () => {
    const o = await openPdf(fixture('aes256-owner-only.pdf'));
    expect(o.encryption).toBe('owner-password-only');
    expect(o.producer).toContain('LibreOffice');
  });

  it('asks for the password to open, and tells a wrong one apart', async () => {
    await expect(openPdf(fixture('aes128-user-password.pdf'))).rejects.toMatchObject({ wrongPassword: false });
    await expect(openPdf(fixture('aes128-user-password.pdf'), 'nope')).rejects.toBeInstanceOf(PasswordRequired);
    const o = await openPdf(fixture('aes128-user-password.pdf'), 'abrir');
    expect(o.encryption).toBe('user-password');
    const [page] = o.doc.getPages().map((p) => interpretPage(o.doc, p.node));
    expect(compact(page.glyphs.map((g) => g.uni).join(''))).toContain('12345678Z');
  });

  it('keeps the producer (no metadata rewrite on load)', async () => {
    expect((await openPdf(fixture('chrome-letter.pdf'))).producer).toContain('Skia');
  });
});

describe('sanitized copy', () => {
  async function dirtyDocument() {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    page.drawText('kept on the page', { x: 20, y: 250, size: 12, font });
    const ctx = doc.context;
    // a figure as pdfTeX includes it, with Illustrator's private data inside
    const figure = ctx.register(ctx.flateStream('BT /F1 10 Tf 0 0 Td (figure text) Tj ET', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 50],
      PieceInfo: { Illustrator: { Private: ctx.register(ctx.flateStream('%%For: (Author Name) original document')) } },
      'PTEX.FileName': PDFString.of('/home/author/figures/secret-plan.pdf'),
      'PTEX.InfoDict': { Author: PDFString.of('Author Name') },
    }));
    // an XObject listed in the resources but never painted: what nobody paints, nobody reviewed
    const unused = ctx.register(ctx.flateStream('BT (UNREVIEWED-SECRET) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] }));
    const xobj = ctx.obj({ Fig: figure, Old: unused });
    page.node.Resources()!.set(PDFName.of('XObject'), xobj);
    const content = ctx.register(ctx.flateStream('q 1 0 0 1 20 100 cm /Fig Do Q'));
    const contents = page.node.Contents();
    const existing = contents instanceof PDFArray ? contents.asArray() : [page.node.get(PDFName.of('Contents'))!];
    page.node.set(PDFName.of('Contents'), ctx.obj([...existing, content]));
    page.node.set(PDFName.of('PieceInfo'), ctx.obj({ App: { Private: PDFString.of('page private data') } }));
    page.node.set(PDFName.of('Annots'), ctx.obj([ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [0, 0, 10, 10], Contents: PDFString.of('a comment') })]));
    doc.catalog.set(PDFName.of('Metadata'), ctx.register(ctx.stream('<x:xmpmeta>author</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' })));
    doc.catalog.set(PDFName.of('OpenAction'), ctx.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }));
    doc.setAuthor('Author Name');
    return PDFDocument.load(await doc.save({ useObjectStreams: false }), { updateMetadata: false });
  }

  it('leaves nothing but what the pages paint', async () => {
    const src = await dirtyDocument();
    expect(residue(src).length).toBeGreaterThan(0);
    const { doc, report } = await sanitizedCopy(src);
    expect(report.xobjectsRemoved).toBe(1);
    expect(report.keysRemoved).toBeGreaterThanOrEqual(3);
    expect(residue(doc)).toEqual([]);
    const bytes = await doc.save({ useObjectStreams: false });
    const raw = new TextDecoder('latin1').decode(bytes);
    for (const s of ['UNREVIEWED-SECRET', 'Author Name', 'secret-plan', 'PieceInfo', 'PTEX', 'app.alert', 'a comment', 'xmpmeta']) {
      expect(raw).not.toContain(s);
    }
    // and what the page paints is still there
    const again = await PDFDocument.load(bytes);
    const page = interpretPage(again, again.getPages()[0].node);
    expect(page.formUses).toHaveLength(1);
    expect(page.glyphs.map((g) => g.uni).join('')).toContain('kept on the page');
  });

  it('drops annotations (a FreeText note) from a real file', async () => {
    const { doc: src } = await openPdf(fixture('freetext-note.pdf'));
    expect(src.getPages()[0].node.has(PDFName.of('Annots'))).toBe(true);
    const { doc } = await sanitizedCopy(src);
    expect(residue(doc)).toEqual([]);
    expect(doc.getPageCount()).toBe(2);
  });
});
