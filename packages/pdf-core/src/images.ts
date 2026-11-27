// Images to PDF: JPEG and PNG, one per page (plan §4).
//
//  - JPEG goes in as it is (DCTDecode), without re-encoding, after stripping
//    EXIF, GPS, XMP and comments at the byte level: photos from a phone carry
//    where they were taken.
//  - The EXIF orientation is read first and applied with the drawing matrix:
//    PDF viewers ignore it, so a portrait photo from a phone would come out
//    lying on its side.
//  - PNG is decoded by pdf-lib (alpha becomes a soft mask); its text chunks
//    do not come along.
import { PDFDocument, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState, type PDFImage } from '@cantoo/pdf-lib';
import { isJpeg, readExif, stripJpeg } from './jpeg';

export type Paper = 'a4' | 'letter' | 'image';
const PAPER = { a4: [595.28, 841.89], letter: [612, 792] } as const;
const MARGIN = 28.35; // 1 cm

export interface ImagesReport { pages: number; jpegMetadataRemoved: number; gpsRemoved: number; turned: number }

const isPng = (b: Uint8Array) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

export class UnsupportedImage extends Error {
  constructor(readonly index: number) { super(`image ${index + 1} is not a JPEG or PNG`); }
}

/**
 * The matrix that draws the image's unit square so that it shows upright in
 * the box (x, y, w, h), for each EXIF orientation. w and h are the box as seen,
 * so for 5–8 they are the stored height and width.
 */
export function orientationMatrix(o: number, x: number, y: number, w: number, h: number): [number, number, number, number, number, number] {
  switch (o) {
    case 2: return [-w, 0, 0, h, x + w, y];
    case 3: return [-w, 0, 0, -h, x + w, y + h];
    case 4: return [w, 0, 0, -h, x, y + h];
    case 5: return [0, -h, -w, 0, x + w, y + h];
    case 6: return [0, -h, w, 0, x, y + h];
    case 7: return [0, h, w, 0, x, y];
    case 8: return [0, h, -w, 0, x + w, y];
    default: return [w, 0, 0, h, x, y];
  }
}

export async function imagesToPdf(images: Uint8Array[], paper: Paper): Promise<{ bytes: Uint8Array; report: ImagesReport }> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const report: ImagesReport = { pages: 0, jpegMetadataRemoved: 0, gpsRemoved: 0, turned: 0 };
  for (const [i, bytes] of images.entries()) {
    let img: PDFImage;
    let orientation = 1;
    if (isJpeg(bytes)) {
      const exif = readExif(bytes);
      orientation = exif.orientation;
      const stripped = stripJpeg(bytes);
      if (stripped.removed.length) report.jpegMetadataRemoved++;
      if (exif.gps) report.gpsRemoved++;
      img = await doc.embedJpg(stripped.bytes);
    } else if (isPng(bytes)) {
      img = await doc.embedPng(bytes);
    } else throw new UnsupportedImage(i);
    if (orientation !== 1) report.turned++;
    const sideways = orientation >= 5;
    const iw = sideways ? img.height : img.width, ih = sideways ? img.width : img.height;
    let pw: number, ph: number, w: number, h: number;
    if (paper === 'image') {
      [pw, ph, w, h] = [iw, ih, iw, ih];
    } else {
      const [a, b] = PAPER[paper];
      [pw, ph] = iw > ih ? [b, a] : [a, b]; // the page turns with the picture
      const k = Math.min((pw - 2 * MARGIN) / iw, (ph - 2 * MARGIN) / ih, 1e9);
      [w, h] = [iw * k, ih * k];
    }
    const page = doc.addPage([pw, ph]);
    const name = page.node.newXObject('Im', img.ref);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...orientationMatrix(orientation, (pw - w) / 2, (ph - h) / 2, w, h)),
      drawObject(name), popGraphicsState());
    report.pages++;
  }
  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, report };
}
