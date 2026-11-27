// Compression, on the generated corpus (plan §4 and §7): photos, scans, text
// only and a «zoo» of images that must not be touched. Each level is measured
// and its rules checked: never larger than the input, only smaller images
// replaced, lossless means identical, and the colour stays where it was.
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFName, PDFRawStream } from '@cantoo/pdf-lib';
import { compressFile, streamDigest, type Level } from '@pdf-core';
import { photoJpeg, photoPdf, scanPdf, textPdf, zooPdf } from '../../../scripts/fixtures.mjs';
import { mad, nodeCodec, render } from './node-codec';

const load = (b: Uint8Array) => PDFDocument.load(b, { updateMetadata: false });
const levels: Level[] = ['lossless', 'medium', 'strong'];
const gain = (before: number, after: number) => 1 - after / before;
const digests = async (b: Uint8Array) => {
  const hashes = await Promise.all([...streamDigest(await load(b)).values()].map(async (x) => Buffer.from(await crypto.subtle.digest('SHA-256', x as BufferSource)).toString('hex')));
  return hashes.sort();
};
const images = async (b: Uint8Array) => (await load(b)).context.enumerateIndirectObjects()
  .filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) as [unknown, PDFRawStream][];

const corpus = {
  'photos (2 JPEG, ~330 ppi)': () => photoPdf({ count: 2 }),
  'scan, grey Flate + predictor (~240 ppi)': () => scanPdf({ pages: 2 }),
  'scan, RGB Flate (~240 ppi)': () => scanPdf({ pages: 1, rgb: true }),
  'text only (uncompressed, classic xref)': () => textPdf({ pages: 3 }),
  'zoo (untouchable images + 2 photos)': async () => (await zooPdf()).bytes,
};
const table: string[] = [];

describe('compression corpus', () => {
  for (const [label, make] of Object.entries(corpus)) {
    it(`${label}: every level keeps the pages and is never larger`, async () => {
      const input = await make();
      const pages = (await load(input)).getPageCount();
      const row = [label, `${(input.length / 1024).toFixed(0)} kB`];
      for (const level of levels) {
        const { bytes, report } = await compressFile({ bytes: input }, level, nodeCodec);
        expect(bytes.length).toBeLessThanOrEqual(input.length);
        expect(report.after).toBe(bytes.length);
        if (report.unchanged) expect(bytes).toBe(input);
        expect((await load(bytes)).getPageCount()).toBe(pages);
        const m = level === 'lossless' ? 0 : mad(await render(input, 0, 0.5), await render(bytes, 0, 0.5));
        row.push(`${(gain(input.length, bytes.length) * 100).toFixed(1)} %${report.unchanged ? ' =' : ''} (MAD ${m.toFixed(2)})`);
        if (level !== 'lossless') expect(m).toBeLessThan(10);
      }
      table.push(`| ${row.join(' | ')} |`);
    });
  }

  it('prints the table', () => {
    console.log(['', '| Corpus | Input | Lossless | Medium | Strong |', '|---|--:|--:|--:|--:|', ...table].join('\n'));
  });
});

describe('compression rules', () => {
  it('lossless: identical content, pixel for pixel', async () => {
    const input = await textPdf({ pages: 3 });
    const { bytes, report } = await compressFile({ bytes: input }, 'lossless', null);
    expect(report.unchanged).toBe(false);
    expect(gain(input.length, bytes.length)).toBeGreaterThan(0.3); // Flate and object streams on an uncompressed file
    expect(await digests(bytes)).toEqual(await digests(input));
    expect(mad(await render(input, 0), await render(bytes, 0))).toBe(0);
  });

  it('medium and strong: photos down to 150 and 100 effective ppi', async () => {
    const input = await photoPdf({ count: 2 });
    const medium = await compressFile({ bytes: input }, 'medium', nodeCodec);
    const strong = await compressFile({ bytes: input }, 'strong', nodeCodec);
    expect(medium.report.images).toMatchObject({ total: 2, replaced: 2, downscaled: 2 });
    expect(gain(input.length, medium.bytes.length)).toBeGreaterThan(0.75);
    expect(strong.bytes.length).toBeLessThan(medium.bytes.length);
    // shown 523 pt wide: 150 ppi is about 1090 px, 100 ppi about 726 px
    const width = async (b: Uint8Array) => (await images(b)).map(([, s]) => (s.dict.get(PDFName.of('Width')) as unknown as { asNumber(): number }).asNumber());
    for (const w of await width(medium.bytes)) expect(Math.abs(w - 1090)).toBeLessThan(4);
    for (const w of await width(strong.bytes)) expect(Math.abs(w - 726)).toBeLessThan(4);
    expect(await digests(medium.bytes)).toEqual(await digests(input)); // only images changed
  });

  it('grey scans come out as RGB JPEG (the canvas writes three channels), and smaller', async () => {
    const input = await scanPdf({ pages: 1 });
    const { bytes, report } = await compressFile({ bytes: input }, 'medium', nodeCodec);
    expect(report.images.replaced).toBe(1);
    const [[, img]] = await images(bytes);
    expect(img.dict.get(PDFName.of('ColorSpace'))).toBe(PDFName.of('DeviceRGB'));
    expect(img.dict.get(PDFName.of('DecodeParms'))).toBeUndefined();
    expect(gain(input.length, bytes.length)).toBeGreaterThan(0.7);
  });

  it('leaves CMYK, indexed, 16-bit, /Decode, one-channel ICC and masks alone; keeps an ICC colour space', async () => {
    const { bytes: input, refs, smask } = await zooPdf();
    const { bytes, report } = await compressFile({ bytes: input }, 'strong', nodeCodec);
    expect(report.images.replaced).toBe(2);
    expect(report.images.skipped).toMatchObject({ colorspace: 2, bits: 1, 'decode-array': 1, 'icc-components': 1, mask: 1 });
    const before = await load(input), after = await load(bytes);
    const contents = (d: PDFDocument, ref: string) => {
      const [n] = ref.split(' ').map(Number);
      const o = d.context.enumerateIndirectObjects().find(([r]) => r.objectNumber === n)?.[1];
      return o instanceof PDFRawStream ? o : undefined;
    };
    for (const k of ['cmyk', 'indexed', 'sixteen', 'decode', 'iccGray'] as const) {
      expect(Buffer.from(contents(after, refs[k])!.contents).equals(Buffer.from(contents(before, refs[k])!.contents)), k).toBe(true);
    }
    expect(Buffer.from(contents(after, smask)!.contents).equals(Buffer.from(contents(before, smask)!.contents))).toBe(true);
    const icc = contents(after, refs.icc)!;
    const cs = icc.dict.lookup(PDFName.of('ColorSpace')) as PDFArray;
    expect(String(cs.get(0))).toBe('/ICCBased');
    expect(icc.dict.get(PDFName.of('Filter'))).toBe(PDFName.of('DCTDecode'));
    expect(contents(after, refs.masked)!.dict.has(PDFName.of('SMask'))).toBe(true);
  });

  it('gives the input back when it cannot do better, and keeps an image the new JPEG would not improve', async () => {
    const once = await compressFile({ bytes: await textPdf({ pages: 2 }) }, 'lossless', null);
    const twice = await compressFile({ bytes: once.bytes }, 'lossless', null);
    expect(twice.report.unchanged).toBe(true);
    expect(twice.bytes).toBe(once.bytes);

    const doc = await PDFDocument.create();
    const img = await doc.embedJpg(photoJpeg(200, 150, { quality: 0.3 })); // already small: quality 0.75 would be larger
    doc.addPage([200, 150]).drawImage(img, { x: 0, y: 0, width: 200, height: 150 });
    const small = await doc.save();
    const r = await compressFile({ bytes: small }, 'medium', nodeCodec);
    expect(r.report.images).toMatchObject({ replaced: 0, notSmaller: 1 });
    expect(r.bytes.length).toBeLessThanOrEqual(small.length);
  });
});
