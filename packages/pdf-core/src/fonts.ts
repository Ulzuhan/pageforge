// Font metrics and the map to Unicode: just enough to place every glyph and to
// know which letter it is. A glyph whose letter cannot be known is reported as
// such (uni undefined); InkBar sends that page to rasterization rather than
// risk a silent false negative.
import { Font as StdFont, Encodings, type FontNames } from '@pdf-lib/standard-fonts';
import { PDFArray, PDFDict, PDFStream, type PDFContext, type PDFRef } from '@cantoo/pdf-lib';
import { get, look, name, num, nums, streamBytes } from './objects';
import { binaryString } from './tokenize';

export interface FontInfo {
  kind: string;          // Type0, Type1, TrueType, Type3, MMType1, broken
  enc: string;           // what the letters come from: ToUnicode, WinAnsiEncoding, Identity-H…
  base: string;
  bytesPerCode: 1 | 2;
  width: (code: number) => number;   // glyph space, 1/1000 em
  uni: (code: number) => string | undefined;
  ascent: number;
  descent: number;
  /** false: this font cannot be operated on safely (and why). */
  ok: boolean;
  reason: string | null;
}

const STD14 = new Set(['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique', 'Helvetica', 'Helvetica-Bold',
  'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Symbol', 'ZapfDingbats']);

// unicodeMappings is private in the typings but public at runtime; it is the table we need.
type Mappings = Record<string, [number, string]>;
const mappings = (e: unknown) => (e as { unicodeMappings: Mappings }).unicodeMappings;
const WIN = new Map<number, { uni: string; name: string }>();
const NAME2UNI = new Map<string, string>();
for (const [uni, [code, glyph]] of Object.entries(mappings(Encodings.WinAnsi))) {
  WIN.set(code, { uni: String.fromCodePoint(+uni), name: glyph });
  NAME2UNI.set(glyph, String.fromCodePoint(+uni));
}
for (const E of [Encodings.Symbol, Encodings.ZapfDingbats]) {
  for (const [uni, [, glyph]] of Object.entries(mappings(E))) {
    if (!NAME2UNI.has(glyph)) NAME2UNI.set(glyph, String.fromCodePoint(+uni));
  }
}
// Ligatures and a few TeX names (dvips writes /fi, /lessmuch, /epsilon1…). In the
// spike a single untranslated «fi» sent 20 of 22 pages of a paper to rasterization.
for (const [n, u] of Object.entries({
  ff: 'ﬀ', fi: 'ﬁ', fl: 'ﬂ', ffi: 'ﬃ', ffl: 'ﬄ', dotlessi: 'ı', dotlessj: 'ȷ',
  lessmuch: '≪', greatermuch: '≫', epsilon1: 'ϵ', vector: '⃗', minus: '−', hyphen: '-',
  sfthyphen: '­', dotaccent: '˙', negationslash: '̸', prime: '′', contourintegral: '∮',
})) NAME2UNI.set(n, u);

/** Glyph name → Unicode, with the Adobe Glyph List rules that matter in practice. */
export function glyphNameToUnicode(n: string | undefined): string | undefined {
  if (!n) return undefined;
  const known = NAME2UNI.get(n);
  if (known !== undefined) return known;
  let m = n.match(/^uni((?:[0-9A-F]{4})+)$/);
  if (m) return m[1].match(/.{4}/g)!.map((h) => String.fromCodePoint(parseInt(h, 16))).join('');
  m = n.match(/^u([0-9A-F]{4,6})$/);
  if (m) { const cp = parseInt(m[1], 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : undefined; }
  if (n.includes('.')) return glyphNameToUnicode(n.split('.')[0]);
  // sizes and pieces of TeX's extensible delimiters: bracketleftbig, parenleftBigg, integraldisplay…
  m = n.match(/^(.+?)(big|Big|bigg|Bigg|tp|bt|ex|mid|text|display)$/);
  if (m && NAME2UNI.has(m[1])) return NAME2UNI.get(m[1]);
  if (n.includes('_')) {
    const parts = n.split('_').map(glyphNameToUnicode);
    return parts.every((x) => x !== undefined) ? parts.join('') : undefined;
  }
  return undefined;
}

const MACROMAN_HI = 'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';
const macRoman = (c: number) => (c >= 32 && c < 127 ? String.fromCharCode(c) : c >= 128 ? MACROMAN_HI[c - 128] : undefined);

/** ToUnicode CMap: bfchar and bfrange (both forms). */
export function parseToUnicode(text: string): Map<number, string> {
  const map = new Map<number, string>();
  const hexToStr = (h: string) => {
    if (h.length === 2) return String.fromCharCode(parseInt(h, 16));
    let s = '';
    for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.substr(i, 4), 16));
    return s;
  };
  for (const blk of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1], 16), hexToStr(m[2]));
  }
  for (const blk of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (m[3].startsWith('[')) {
        const items = [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => hexToStr(x[1]));
        for (let c = lo; c <= hi && c - lo < items.length; c++) map.set(c, items[c - lo]);
      } else {
        const s0 = hexToStr(m[3].slice(1, -1));
        if (!s0) continue;
        for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, s0.slice(0, -1) + String.fromCharCode(s0.charCodeAt(s0.length - 1) + (c - lo)));
      }
    }
  }
  return map;
}

function broken(reason: string): FontInfo {
  return { kind: 'broken', enc: '—', base: '?', bytesPerCode: 1, width: () => 0, uni: () => undefined, ascent: 800, descent: -200, ok: false, reason };
}

export function makeFontReader(ctx: PDFContext) {
  const cache = new Map<string, FontInfo>();
  const metrics = (fd: PDFDict | undefined, std?: StdFont | null) => {
    let ascent = num(get(ctx, fd, 'Ascent')) ?? std?.Ascender;
    let descent = num(get(ctx, fd, 'Descent')) ?? std?.Descender;
    if (!(ascent! > 0)) ascent = 800;
    if (!(descent! < 0)) descent = -200;
    return { ascent: ascent!, descent: descent! };
  };

  return function readFont(ref: PDFRef | PDFDict): FontInfo {
    const key = ref.toString();
    const hit = cache.get(key);
    if (hit) return hit;
    const d = look(ctx, ref);
    let f: FontInfo;
    if (!(d instanceof PDFDict)) f = broken('missing font object');
    else {
      try { f = readDict(d); } catch (e) { f = broken(`unreadable font: ${(e as Error).message}`); }
    }
    cache.set(key, f);
    return f;
  };

  function readDict(d: PDFDict): FontInfo {
    const sub = name(get(ctx, d, 'Subtype'));
    const base = name(get(ctx, d, 'BaseFont')) ?? '';
    const tuStream = get(ctx, d, 'ToUnicode');
    const tu = tuStream instanceof PDFStream ? parseToUnicode(binaryString(streamBytes(ctx, tuStream))) : null;

    if (sub === 'Type0') {
      const encName = name(get(ctx, d, 'Encoding'));
      const descendants = get(ctx, d, 'DescendantFonts');
      const desc0 = descendants instanceof PDFArray ? look(ctx, descendants.get(0)) : undefined;
      const cid = desc0 instanceof PDFDict ? desc0 : undefined;
      const dw = num(get(ctx, cid, 'DW')) ?? 1000;
      const W = new Map<number, number>();
      const warr = get(ctx, cid, 'W');
      if (warr instanceof PDFArray) {
        const a = warr.asArray().map((x) => look(ctx, x));
        for (let i = 0; i < a.length;) {
          const c0 = num(a[i]);
          const next = a[i + 1];
          if (c0 === undefined) break;
          if (next instanceof PDFArray) { next.asArray().forEach((w, k) => W.set(c0 + k, num(look(ctx, w)) ?? dw)); i += 2; }
          else { const c1 = num(next), w = num(a[i + 2]); if (c1 === undefined || w === undefined) break; for (let c = c0; c <= c1 && c - c0 < 65536; c++) W.set(c, w); i += 3; }
        }
      }
      const ok = encName === 'Identity-H';
      return {
        kind: 'Type0', enc: encName ?? 'embedded CMap', base, bytesPerCode: 2, width: (c) => W.get(c) ?? dw,
        uni: (c) => tu?.get(c), ...metrics(asDictOrUndef(get(ctx, cid, 'FontDescriptor'))),
        ok: ok && !!tu, reason: !ok ? (encName === 'Identity-V' ? 'vertical writing (Identity-V)' : `CMap ${encName ?? 'embedded'}`) : (!tu ? 'no ToUnicode' : null),
      };
    }
    if (sub === 'Type3') {
      const fc = num(get(ctx, d, 'FirstChar')) ?? 0;
      const ws = nums(ctx, get(ctx, d, 'Widths')) ?? [];
      const fm = nums(ctx, get(ctx, d, 'FontMatrix')) ?? [0.001];
      const k = fm[0] * 1000;
      return { kind: 'Type3', enc: '—', base: 'Type3', bytesPerCode: 1, width: (c) => (ws[c - fc] ?? 0) * k, uni: (c) => tu?.get(c),
        ascent: 800, descent: -200, ok: false, reason: 'Type3 font' };
    }
    // Type1, TrueType, MMType1
    const fc = num(get(ctx, d, 'FirstChar')) ?? 0;
    const ws = nums(ctx, get(ctx, d, 'Widths'));
    const fd = asDictOrUndef(get(ctx, d, 'FontDescriptor'));
    const missing = num(get(ctx, fd, 'MissingWidth')) ?? 0;
    const std = !ws && STD14.has(base) ? StdFont.load(base as FontNames) : null;
    const enc = get(ctx, d, 'Encoding');
    const names = new Map<number, string>();
    const baseEnc = enc instanceof PDFDict ? name(get(ctx, enc, 'BaseEncoding')) : name(enc);
    if (enc instanceof PDFDict) {
      const diffs = get(ctx, enc, 'Differences');
      if (diffs instanceof PDFArray) {
        let c = 0;
        for (const x of diffs.asArray()) {
          const v = look(ctx, x);
          const n = num(v);
          if (n !== undefined) c = n;
          else { const g = name(v); if (g) names.set(c, g); c++; }
        }
      }
    }
    const winLike = !baseEnc || baseEnc === 'WinAnsiEncoding' || baseEnc === 'StandardEncoding';
    const glyphName = (c: number) => names.get(c) ?? (winLike ? WIN.get(c)?.name : undefined);
    const width = ws ? (c: number) => (c >= fc && c - fc < ws.length ? ws[c - fc] : missing)
      : std ? (c: number) => { const g = glyphName(c); return g ? std.getWidthOfGlyph(g) ?? 0 : 0; } : () => missing;
    const uni = (c: number) => tu?.get(c) ?? (names.has(c) ? glyphNameToUnicode(names.get(c))
      : baseEnc === 'MacRomanEncoding' ? macRoman(c) : winLike ? WIN.get(c)?.uni : undefined);
    const symbolic = !tu && !enc && !std; // a symbolic TrueType without ToUnicode: no way to know the letter
    return {
      kind: sub ?? 'simple', enc: tu ? 'ToUnicode' : (baseEnc ?? (names.size ? 'Differences' : (std ? 'standard' : 'built-in'))),
      base, bytesPerCode: 1, width, uni, ...metrics(fd, std),
      ok: !symbolic && (!!ws || !!std), reason: symbolic ? 'no ToUnicode' : (!ws && !std ? 'no Widths' : null),
    };
  }
}

const asDictOrUndef = (o: unknown) => (o instanceof PDFDict ? o : undefined);
