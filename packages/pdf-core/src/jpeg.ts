// JPEG at the byte level, without decoding a pixel (spike, P5).
//
// stripJpeg keeps a whitelist of markers: APP0 JFIF, APP2 ICC_PROFILE and
// APP14 Adobe. Every other APPn (EXIF, XMP, IPTC, MPF…), every comment and
// everything after EOI (where phones keep previews with their own GPS) goes.
// DQT, DHT, SOFn, DRI and the scans are copied as they are, so the pixels come
// out identical.

export interface Removed { marker: string; id: string; bytes: number }
export interface Stripped { bytes: Uint8Array; removed: Removed[]; trailing: number }

const ascii = (b: Uint8Array, n: number) => String.fromCharCode(...b.subarray(0, n)).replace(/\0[\s\S]*$/, '');

function keep(m: number, payload: Uint8Array): boolean {
  if (m === 0xfe) return false; // COM
  if (m < 0xe0 || m > 0xef) return true; // not APPn
  if (m === 0xe0) return ascii(payload, 5) === 'JFIF';
  if (m === 0xe2) return ascii(payload, 12) === 'ICC_PROFILE';
  if (m === 0xee) return ascii(payload, 5) === 'Adobe';
  return false;
}

export const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Splits a JPEG into its segments. A scan segment runs to the next real marker. */
function* segments(buf: Uint8Array): Generator<{ start: number; end: number; marker: number; payload: Uint8Array }, number> {
  if (!isJpeg(buf)) throw new Error('not a JPEG');
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error(`expected a marker at ${i}`);
    while (buf[i + 1] === 0xff) i++; // fill bytes
    const m = buf[i + 1];
    if (m === 0xd9) { yield { start: i, end: i + 2, marker: m, payload: new Uint8Array() }; return i + 2; }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { yield { start: i, end: i + 2, marker: m, payload: new Uint8Array() }; i += 2; continue; }
    if (i + 4 > buf.length) throw new Error('truncated JPEG');
    const end = i + 2 + ((buf[i + 2] << 8) | buf[i + 3]);
    if (end > buf.length) throw new Error(`truncated segment 0x${m.toString(16)}`);
    if (m === 0xda) {
      let j = end;
      while (j < buf.length) {
        if (buf[j] === 0xff) {
          const n = buf[j + 1];
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { j += 2; continue; }
          if (n === 0xff) { j++; continue; }
          break;
        }
        j++;
      }
      yield { start: i, end: j, marker: m, payload: buf.subarray(i + 4, end) };
      i = j;
      continue;
    }
    yield { start: i, end, marker: m, payload: buf.subarray(i + 4, end) };
    i = end;
  }
  return i;
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function stripJpeg(buf: Uint8Array): Stripped {
  const parts = [buf.subarray(0, 2)];
  const removed: Removed[] = [];
  const it = segments(buf);
  let r = it.next();
  while (!r.done) {
    const s = r.value;
    if (keep(s.marker, s.payload)) parts.push(buf.subarray(s.start, s.end));
    else removed.push({ marker: s.marker === 0xfe ? 'COM' : `APP${s.marker - 0xe0}`, id: s.marker === 0xfe ? '' : ascii(s.payload, 30), bytes: s.end - s.start });
    r = it.next();
  }
  const trailing = buf.length - r.value;
  if (trailing > 0) removed.push({ marker: 'after EOI', id: '', bytes: trailing });
  return { bytes: join(parts), removed, trailing };
}

export interface JpegInfo { width: number; height: number; components: number; progressive: boolean }

export function jpegInfo(buf: Uint8Array): JpegInfo {
  for (const s of segments(buf)) {
    const m = s.marker;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const p = s.payload;
      return { height: (p[1] << 8) | p[2], width: (p[3] << 8) | p[4], components: p[5], progressive: m === 0xc2 || m === 0xc6 || m === 0xca || m === 0xce };
    }
    if (m === 0xda) break;
  }
  throw new Error('JPEG without a frame header');
}

/** The JPEG without any APP2 (ICC), so that a decoder cannot apply the profile. */
export function withoutIcc(buf: Uint8Array): Uint8Array {
  const s = stripJpeg(buf).bytes;
  const parts = [s.subarray(0, 2)];
  for (const seg of segments(s)) if (seg.marker !== 0xe2) parts.push(s.subarray(seg.start, seg.end));
  return join(parts);
}

/** Only the markers a decoder needs: no APPn at all, no comment. For re-encoded output. */
export function bare(buf: Uint8Array): Uint8Array {
  const parts = [buf.subarray(0, 2)];
  for (const seg of segments(buf)) {
    const app = seg.marker >= 0xe0 && seg.marker <= 0xef;
    const jfif = seg.marker === 0xe0 && ascii(seg.payload, 5) === 'JFIF';
    if ((!app || jfif) && seg.marker !== 0xfe) parts.push(buf.subarray(seg.start, seg.end));
  }
  return join(parts);
}

/** The original APP2 ICC segments, to give back to a re-encoded image. */
export function iccSegments(buf: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const seg of segments(buf)) {
    if (seg.marker === 0xda) break;
    if (seg.marker === 0xe2 && ascii(seg.payload, 12) === 'ICC_PROFILE') out.push(buf.subarray(seg.start, seg.end));
  }
  return out;
}

export function insertAfterApp0(jpeg: Uint8Array, segs: Uint8Array[]): Uint8Array {
  if (!segs.length) return jpeg;
  const at = jpeg[3] === 0xe0 ? 4 + ((jpeg[4] << 8) | jpeg[5]) : 2;
  return join([jpeg.subarray(0, at), ...segs, jpeg.subarray(at)]);
}

export interface Exif { orientation: number; gps: boolean }

/**
 * What the EXIF block says, read from its TIFF structure: the orientation
 * (1–8; PDF viewers ignore it, so images-to-PDF applies it) and whether there
 * is a GPS directory (the Clean report says so).
 */
export function readExif(buf: Uint8Array): Exif {
  const none = { orientation: 1, gps: false };
  for (const seg of segments(buf)) {
    if (seg.marker === 0xda) break;
    if (seg.marker !== 0xe1 || ascii(seg.payload, 4) !== 'Exif') continue;
    const t = seg.payload.subarray(6);
    if (t.length < 8) return none;
    const le = t[0] === 0x49;
    const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
    const u16 = (o: number) => dv.getUint16(o, le), u32 = (o: number) => dv.getUint32(o, le);
    try {
      const ifd = u32(4);
      const n = u16(ifd);
      let orientation = 1, gps = false;
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        const tag = u16(e);
        if (tag === 0x0112) { const v = u16(e + 8); if (v >= 1 && v <= 8) orientation = v; }
        if (tag === 0x8825) gps = true;
      }
      return { orientation, gps };
    } catch {
      return none; // a broken EXIF block: no orientation, and it goes anyway
    }
  }
  return none;
}
