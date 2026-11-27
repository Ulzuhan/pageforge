import { describe, expect, it } from 'vitest';
import { loadImage, createCanvas } from '@napi-rs/canvas';
import { isJpeg, jpegInfo, readExif, stripJpeg, withoutIcc } from '@pdf-core';
import { MARKERS, comSegment, exifApp1, insertSegment, photoJpeg, xmpApp1 } from '../../../scripts/fixtures.mjs';

const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');
const pixels = async (b: Uint8Array) => {
  const img = await loadImage(Buffer.from(b));
  const c = createCanvas(img.width, img.height);
  c.getContext('2d').drawImage(img, 0, 0);
  return c.getContext('2d').getImageData(0, 0, img.width, img.height).data;
};

describe('JPEG metadata (spike P5)', () => {
  it('removes EXIF with GPS, XMP, comments and what follows EOI, and keeps the pixels and the ICC profile', async () => {
    const tail = photoJpeg(64, 48, { exif: { gps: true } });
    const jpeg = Uint8Array.from([...photoJpeg(320, 240, { meta: true }), ...tail]); // a «preview» after EOI, with its own GPS
    expect(readExif(jpeg)).toEqual({ orientation: 1, gps: true });
    const out = stripJpeg(jpeg);
    for (const m of [MARKERS.exif, MARKERS.xmp, MARKERS.comment, 'Exif']) {
      expect(latin1(jpeg)).toContain(m);
      expect(latin1(out.bytes)).not.toContain(m);
    }
    expect(out.trailing).toBe(tail.length);
    expect(out.removed.map((r) => r.marker)).toEqual(expect.arrayContaining(['APP1', 'COM', 'after EOI']));
    expect(latin1(out.bytes)).toContain('ICC_PROFILE'); // the canvas library writes one; it stays
    expect(await pixels(out.bytes)).toEqual(await pixels(jpeg.subarray(0, jpeg.length - tail.length)));
    expect(stripJpeg(out.bytes).removed).toEqual([]);
  });

  it('reads the orientation and the frame', () => {
    const j = insertSegment(photoJpeg(100, 50), exifApp1({ orientation: 6 }));
    expect(readExif(j).orientation).toBe(6);
    expect(jpegInfo(j)).toMatchObject({ width: 100, height: 50, components: 3 });
    expect(isJpeg(j)).toBe(true);
    expect(latin1(withoutIcc(j))).not.toContain('ICC_PROFILE');
  });

  it('copes with segments in any order and refuses what is not a JPEG', () => {
    const j = insertSegment(insertSegment(photoJpeg(40, 40), comSegment()), xmpApp1());
    expect(stripJpeg(j).removed.length).toBe(2);
    expect(() => stripJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow();
    expect(() => stripJpeg(j.subarray(0, 30))).toThrow();
  });
});
