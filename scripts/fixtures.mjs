// Synthetic test inputs, generated on the fly (nothing binary is committed):
// labelled pages, photos and scans for compression, phone-like JPEGs with EXIF
// and GPS, and a PDF carrying everything «Clean» must find. Used by the unit
// tests (vitest) and by the browser suite. Every value is a public example:
// GPS at 0° 0′ (Null Island), example.com, «Example Author».
import { createCanvas } from '@napi-rs/canvas';
import { zlibSync } from 'fflate';
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, StandardFonts,
  concatTransformationMatrix, decodePDFRawStream, drawObject, popGraphicsState, pushGraphicsState,
} from '@cantoo/pdf-lib';

export const MARKERS = {
  exif: 'EXIF-MARKER-0001', comment: 'COMMENT-MARKER-0002', xmp: 'XMP-MARKER-0003', author: 'Example Author',
  title: 'Example title', attachment: 'ATTACHMENT-MARKER-0004', js: 'JS-MARKER-0005', piece: 'PIECE-MARKER-0006',
  field: 'FIELD-VALUE-0007', note: 'NOTE-TEXT-0008', hidden: 'HIDDEN-TEXT-0009',
};

const N = (s) => PDFName.of(s);
const enc = new TextEncoder();
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** mulberry32: the same «random» picture every run. */
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function photoCanvas(w, h, seed) {
  const r = rng(seed);
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#3d6fb5'); sky.addColorStop(0.6, '#a9c6e8'); sky.addColorStop(1, '#e9d9b8');
  g.fillStyle = sky; g.fillRect(0, 0, w, h);
  for (let k = 0; k < 3; k++) { // hills
    g.fillStyle = ['#4f6b3a', '#3c5530', '#2c3f24'][k];
    g.beginPath(); g.moveTo(0, h);
    for (let x = 0; x <= w; x += w / 24) g.lineTo(x, h * (0.55 + k * 0.12) + Math.sin(x / w * 7 + k * 2 + r()) * h * 0.05);
    g.lineTo(w, h); g.closePath(); g.fill();
  }
  for (let k = 0; k < 14; k++) { // soft blobs
    const x = r() * w, y = r() * h, rad = (0.05 + r() * 0.2) * Math.min(w, h);
    const rg = g.createRadialGradient(x, y, 0, x, y, rad);
    rg.addColorStop(0, `rgba(${Math.floor(r() * 255)},${Math.floor(r() * 255)},${Math.floor(r() * 255)},0.55)`);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fillRect(x - rad, y - rad, 2 * rad, 2 * rad);
  }
  const id = g.getImageData(0, 0, w, h), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * 18; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(id, 0, 0);
  return c;
}

/** The first segment after SOI (and after APP0, if there is one) is where EXIF goes. */
export function insertSegment(jpeg, seg) {
  const at = jpeg[3] === 0xe0 ? 4 + ((jpeg[4] << 8) | jpeg[5]) : 2;
  return concat(jpeg.subarray(0, at), seg, jpeg.subarray(at));
}

const segment = (marker, payload) => concat(new Uint8Array([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload);

/** An EXIF block (big-endian TIFF): description, orientation and, if asked, a GPS directory at 0° 0′. */
export function exifApp1({ orientation = 1, gps = false, description = MARKERS.exif } = {}) {
  const desc = enc.encode(`${description}\0`);
  const ifd0 = [[0x010e, 2, desc.length, 'desc'], [0x0112, 3, 1, orientation]];
  if (gps) ifd0.push([0x8825, 4, 1, 'gps']);
  const gpsIfd = [[0x0000, 1, 4, [2, 3, 0, 0]], [0x0001, 2, 2, 'N'], [0x0002, 5, 3, 'lat'], [0x0003, 2, 2, 'E'], [0x0004, 5, 3, 'lon']];
  const ifd0Size = 2 + ifd0.length * 12 + 4;
  const gpsAt = 8 + ifd0Size;
  const gpsSize = 2 + gpsIfd.length * 12 + 4;
  const descAt = gpsAt + (gps ? gpsSize : 0);
  const latAt = descAt + desc.length, lonAt = latAt + 24;
  const buf = new Uint8Array(lonAt + 24);
  const dv = new DataView(buf.buffer);
  buf.set([0x4d, 0x4d, 0, 42]); dv.setUint32(4, 8);
  const writeIfd = (at, entries) => {
    dv.setUint16(at, entries.length);
    entries.forEach(([tag, type, count, v], k) => {
      const e = at + 2 + k * 12;
      dv.setUint16(e, tag); dv.setUint16(e + 2, type); dv.setUint32(e + 4, count);
      if (v === 'desc') dv.setUint32(e + 8, descAt);
      else if (v === 'gps') dv.setUint32(e + 8, gpsAt);
      else if (v === 'lat') dv.setUint32(e + 8, latAt);
      else if (v === 'lon') dv.setUint32(e + 8, lonAt);
      else if (typeof v === 'string') buf.set(enc.encode(`${v}\0`), e + 8);
      else if (Array.isArray(v)) buf.set(v, e + 8);
      else if (type === 3) dv.setUint16(e + 8, v);
      else dv.setUint32(e + 8, v);
    });
    dv.setUint32(at + 2 + entries.length * 12, 0);
  };
  writeIfd(8, ifd0);
  if (gps) writeIfd(gpsAt, gpsIfd);
  buf.set(desc, descAt);
  for (const at of [latAt, lonAt]) for (let k = 0; k < 3; k++) { dv.setUint32(at + k * 8, 0); dv.setUint32(at + k * 8 + 4, 1); }
  return segment(0xe1, concat(enc.encode('Exif\0\0'), buf));
}

export const xmpApp1 = () => segment(0xe1, concat(enc.encode('http://ns.adobe.com/xap/1.0/\0'),
  enc.encode(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:Description>${MARKERS.xmp}</rdf:Description></x:xmpmeta>`)));
export const comSegment = () => segment(0xfe, enc.encode(MARKERS.comment));

/** A photo-like JPEG; with `meta`, EXIF (and GPS), XMP and a comment, as a phone would leave them. */
export function photoJpeg(w, h, { quality = 0.92, seed = 1, exif, meta = false } = {}) {
  let jpeg = new Uint8Array(photoCanvas(w, h, seed).toBuffer('image/jpeg', Math.round(quality * 100)));
  if (meta) jpeg = insertSegment(insertSegment(insertSegment(jpeg, comSegment()), xmpApp1()), exifApp1({ gps: true }));
  if (exif) jpeg = insertSegment(jpeg, exifApp1(exif));
  return jpeg;
}

/** Stored w×h, with the top-left quarter red and the rest grey: shows where the top-left ended up. */
export function quadrantJpeg(w, h, orientation) {
  const c = createCanvas(w, h), g = c.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#ff0000'; g.fillRect(0, 0, w / 2, h / 2);
  return insertSegment(new Uint8Array(c.toBuffer('image/jpeg', 95)), exifApp1({ orientation, gps: true }));
}

export function photoPng(w, h, { alpha = false, seed = 2 } = {}) {
  const c = photoCanvas(w, h, seed);
  if (alpha) {
    const g = c.getContext('2d'), id = g.getImageData(0, 0, w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) id.data[(y * w + x) * 4 + 3] = Math.round(255 * x / w);
    g.putImageData(id, 0, 0);
  }
  return new Uint8Array(c.toBuffer('image/png'));
}

/** The sRGB profile the canvas library writes into its JPEGs (APP2): a real ICC profile to test ICCBased with. */
export function srgbProfile() {
  const j = new Uint8Array(createCanvas(8, 8).toBuffer('image/jpeg', 90));
  for (let i = 2; i < j.length;) {
    const m = j[i + 1], len = (j[i + 2] << 8) | j[i + 3];
    if (m === 0xe2) return j.subarray(i + 4 + 14, i + 2 + len);
    if (m === 0xda) break;
    i += 2 + len;
  }
  throw new Error('the canvas library wrote no ICC profile');
}

const A4 = [595.28, 841.89];

function draw(page, xname, [a, b, c, d, e, f]) {
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(a, b, c, d, e, f), drawObject(xname), popGraphicsState());
}

/** Pages whose size tells them apart (500+i points wide by default), each with its label in Helvetica. */
export async function labelledPdf(labels, { sizes, link = false, risky = false } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = labels.map((label, i) => {
    const [w, h] = sizes?.[i] ?? [500 + i, 700];
    const p = doc.addPage([w, h]);
    p.drawText(label, { x: 40, y: h - 100, size: 36, font });
    return p;
  });
  const ctx = doc.context;
  const annots = (p, list) => p.node.set(N('Annots'), ctx.obj(list.map((a) => ctx.register(ctx.obj(a)))));
  if (link && pages.length > 1) {
    annots(pages[0], [
      { Type: 'Annot', Subtype: 'Link', Rect: [40, 40, 200, 60], Border: [0, 0, 0], Dest: [pages[1].ref, 'XYZ', 0, 700, 0] },
      { Type: 'Annot', Subtype: 'Link', Rect: [40, 80, 200, 100], Border: [0, 0, 0], A: { S: 'URI', URI: PDFString.of('https://example.com/') } },
    ]);
  }
  if (risky) {
    pages[0].node.set(N('AA'), ctx.obj({ O: { S: 'JavaScript', JS: PDFString.of(`console.println("${MARKERS.js}")`) } }));
    const old = pages[0].node.lookup(N('Annots'));
    const list = old instanceof PDFArray ? old.asArray() : [];
    list.push(ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [40, 120, 200, 140], A: { S: 'JavaScript', JS: PDFString.of('app.alert(1)') } })));
    pages[0].node.set(N('Annots'), ctx.obj(list));
  }
  return doc.save();
}

/** Big JPEG photos shown across an A4 page: ~330 ppi, what a phone or a camera leaves. */
export async function photoPdf({ count = 2, px = [2400, 1600], quality = 0.92 } = {}) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) {
    const img = await doc.embedJpg(photoJpeg(px[0], px[1], { quality, seed: 10 + i }));
    const page = doc.addPage(A4);
    const w = A4[0] - 72, h = w * px[1] / px[0];
    page.drawImage(img, { x: 36, y: A4[1] - 36 - h, width: w, height: h });
  }
  return doc.save();
}

function scanPixels(w, h, rgb, seed) {
  const r = rng(seed);
  const out = new Uint8Array(w * h * (rgb ? 3 : 1)).fill(0);
  const ink = new Uint8Array(w * h);
  for (let y = Math.floor(h * 0.08); y < h * 0.9; y += Math.floor(h / 48)) { // lines of «words»
    let x = Math.floor(w * 0.1);
    while (x < w * 0.88) {
      const ww = Math.floor(w * (0.02 + r() * 0.06)), hh = Math.floor(h / 110);
      for (let yy = y; yy < y + hh; yy++) for (let xx = x; xx < Math.min(x + ww, w); xx++) ink[yy * w + xx] = 1;
      x += ww + Math.floor(w * 0.012);
    }
  }
  for (let p = 0; p < w * h; p++) {
    const n = (r() + r() + r() - 1.5) * 5;
    const v = ink[p] ? 30 + n : 242 + n;
    if (rgb) { out[p * 3] = v; out[p * 3 + 1] = v * 0.98; out[p * 3 + 2] = v * 0.92; } else out[p] = v;
  }
  return out;
}

/** «Scanned» A4 pages at ~240 ppi: grey Flate with a PNG predictor, or RGB Flate without one. */
export async function scanPdf({ pages = 2, rgb = false, w = 2000 } = {}) {
  const doc = await PDFDocument.create();
  const h = Math.round(w * A4[1] / A4[0]);
  for (let i = 0; i < pages; i++) {
    const raw = scanPixels(w, h, rgb, 20 + i);
    let data, parms;
    if (rgb) data = zlibSync(raw, { level: 6 });
    else {
      const rows = new Uint8Array((w + 1) * h); // PNG «None» filter byte at the start of each row
      for (let y = 0; y < h; y++) rows.set(raw.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
      data = zlibSync(rows, { level: 6 });
      parms = { Predictor: 15, Colors: 1, Columns: w, BitsPerComponent: 8 };
    }
    const ref = doc.context.register(doc.context.stream(data, {
      Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: rgb ? 'DeviceRGB' : 'DeviceGray', BitsPerComponent: 8,
      Filter: 'FlateDecode', ...(parms ? { DecodeParms: parms } : {}),
    }));
    const page = doc.addPage(A4);
    draw(page, page.node.newXObject('Scan', ref), [A4[0], 0, 0, A4[1], 0, 0]);
  }
  return doc.save();
}

/** Text only, the way older producers write it: uncompressed content and a classic cross-reference table. */
export async function textPdf({ pages = 3 } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const r = rng(5);
  const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore'.split(' ');
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage(A4);
    const fname = page.node.newFontDictionary('F1', font.ref);
    let ops = `BT /${fname.decodeText()} 11 Tf 14 TL 56 780 Td\n`;
    for (let l = 0; l < 48; l++) ops += `(${Array.from({ length: 12 }, () => words[Math.floor(r() * words.length)]).join(' ')}) '\n`;
    ops += 'ET\n';
    page.node.set(N('Contents'), doc.context.register(doc.context.stream(ops)));
  }
  return doc.save({ useObjectStreams: false });
}

/** One page of images compression must leave alone, plus two it may change. */
export async function zooPdf() {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const page = doc.addPage(A4);
  const flat = (w, h, comps, bpc = 8, v = 128) => zlibSync(new Uint8Array(w * h * comps * (bpc / 8)).fill(v));
  const img = (dict, data) => ctx.register(ctx.stream(data, { Type: 'XObject', Subtype: 'Image', BitsPerComponent: 8, Filter: 'FlateDecode', ...dict }));
  const icc3 = ctx.register(ctx.flateStream(srgbProfile(), { N: 3, Alternate: 'DeviceRGB' }));
  const icc1 = ctx.register(ctx.flateStream(new Uint8Array(200).fill(7), { N: 1, Alternate: 'DeviceGray' }));
  const smask = img({ Width: 400, Height: 300, ColorSpace: 'DeviceGray' }, flat(400, 300, 1, 8, 200));
  const photo = (seed) => photoJpeg(1600, 1200, { quality: 0.92, seed });
  const items = {
    cmyk: img({ Width: 64, Height: 64, ColorSpace: 'DeviceCMYK' }, flat(64, 64, 4)),
    indexed: img({ Width: 64, Height: 64, ColorSpace: [N('Indexed'), N('DeviceRGB'), 1, PDFHexString.of('ff00000000ff')] }, flat(64, 64, 1, 8, 1)),
    sixteen: img({ Width: 64, Height: 64, ColorSpace: 'DeviceGray', BitsPerComponent: 16 }, flat(64, 64, 1, 16)),
    decode: img({ Width: 64, Height: 64, ColorSpace: 'DeviceRGB', Decode: [1, 0, 1, 0, 1, 0] }, flat(64, 64, 3)),
    iccGray: img({ Width: 64, Height: 64, ColorSpace: [N('ICCBased'), icc1] }, flat(64, 64, 1)),
    masked: ctx.register(ctx.stream(photo(31), { Type: 'XObject', Subtype: 'Image', Width: 1600, Height: 1200, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode', SMask: smask })),
    icc: ctx.register(ctx.stream(photo(32), { Type: 'XObject', Subtype: 'Image', Width: 1600, Height: 1200, ColorSpace: [N('ICCBased'), icc3], BitsPerComponent: 8, Filter: 'DCTDecode' })),
  };
  let x = 30;
  for (const [k, ref] of Object.entries(items)) {
    const big = k === 'masked' || k === 'icc';
    draw(page, page.node.newXObject(k, ref), big ? [200, 0, 0, 150, x, 500] : [60, 0, 0, 60, x, 300]);
    x += big ? 210 : 70;
  }
  return { bytes: await doc.save(), refs: Object.fromEntries(Object.entries(items).map(([k, r]) => [k, r.toString()])), smask: smask.toString() };
}

/** Everything «Clean» must find, including an earlier version kept by an incremental save. */
export async function cleanSamplePdf() {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.setTitle(MARKERS.title); doc.setAuthor(MARKERS.author); doc.setSubject('Example subject');
  doc.setKeywords(['example']); doc.setCreator('Example Creator'); doc.setProducer('Example Producer');
  const page = doc.addPage(A4);
  page.drawText('Visible page text', { x: 56, y: 780, size: 18, font });
  const jpeg = await doc.embedJpg(photoJpeg(800, 600, { meta: true, seed: 40 }));
  page.drawImage(jpeg, { x: 56, y: 420, width: 320, height: 240 });

  const form = doc.getForm();
  const field = form.createTextField('name');
  field.setText(MARKERS.field);
  field.addToPage(page, { x: 56, y: 360, width: 260, height: 24, font });
  const box = form.createCheckBox('agree');
  box.addToPage(page, { x: 56, y: 320, width: 18, height: 18 });
  box.check();
  form.updateFieldAppearances(font);

  const ap = (text) => ctx.register(ctx.stream(`BT /Helv 12 Tf 2 6 Td (${text}) Tj ET`, {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 24], Resources: { Font: { Helv: font.ref } },
  }));
  const annot = (d) => ctx.register(ctx.obj({ Type: 'Annot', ...d }));
  const existing = page.node.lookup(N('Annots'));
  const list = existing instanceof PDFArray ? existing.asArray() : [];
  list.push(annot({ Subtype: 'FreeText', Rect: [300, 280, 500, 304], Contents: PDFString.of(MARKERS.note), DA: PDFString.of('/Helv 12 Tf 0 g'), AP: { N: ap(MARKERS.note) } }));
  list.push(annot({ Subtype: 'FreeText', Rect: [300, 240, 500, 264], F: 2, Contents: PDFString.of(MARKERS.hidden), DA: PDFString.of('/Helv 12 Tf 0 g'), AP: { N: ap(MARKERS.hidden) } }));
  list.push(annot({ Subtype: 'Link', Rect: [56, 200, 200, 220], A: { S: 'URI', URI: PDFString.of('https://example.com/') } }));
  page.node.set(N('Annots'), ctx.obj(list));
  page.node.set(N('PieceInfo'), ctx.obj({ Illustrator: { Private: PDFString.of(MARKERS.piece) } }));

  const xmp = ctx.register(ctx.stream(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><dc:creator>${MARKERS.author}</dc:creator></x:xmpmeta>`, { Type: 'Metadata', Subtype: 'XML' }));
  doc.catalog.set(N('Metadata'), xmp);
  doc.catalog.set(N('OpenAction'), ctx.obj({ S: 'JavaScript', JS: PDFString.of(`console.println("${MARKERS.js}")`) }));
  doc.catalog.set(N('Outlines'), ctx.obj({ Type: 'Outlines', Count: 0 }));
  await doc.attach(enc.encode(MARKERS.attachment), 'notes.txt', { mimeType: 'text/plain', description: 'Example attachment' });

  const first = await doc.save({ useObjectStreams: false });
  // An incremental update: the Info dictionary is replaced, the old one stays in the file.
  const text = Buffer.from(first).toString('latin1');
  const prev = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)[1]);
  const size = Number(/\/Size (\d+)/.exec(text.slice(prev))[1]);
  const infoRef = doc.context.trailerInfo.Info;
  const rootRef = doc.context.trailerInfo.Root;
  const objAt = first.length;
  const obj = `${infoRef.objectNumber} 0 obj\n<< /Title (Second title) /Producer (Example Producer) >>\nendobj\n`;
  const xrefAt = objAt + obj.length;
  const xref = `xref\n${infoRef.objectNumber} 1\n${String(objAt).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${size} /Root ${rootRef} /Info ${infoRef} /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return concat(first, enc.encode(obj + xref));
}

/** Every string and every decodable stream of a PDF, as text: to look for markers after Flate and object streams. */
export async function everything(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const parts = [];
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (o instanceof PDFRawStream) {
      parts.push(o.dict.toString());
      try { parts.push(Buffer.from(o.dict.get(N('Filter')) ? decodePDFRawStream(o).decode() : o.contents).toString('latin1')); } catch { parts.push(Buffer.from(o.contents).toString('latin1')); }
    } else parts.push(String(o));
  }
  return parts.join('\n');
}

export { PDFArray, PDFDict, PDFNumber, PDFRef };
