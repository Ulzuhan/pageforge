// Content stream tokenizer (ISO 32000-1 §7.2, §7.8.2). Every operation keeps the
// byte range it came from, so a rewrite can change only what it must and copy
// the rest byte for byte.

export type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; bytes: Uint8Array; hex?: boolean }
  | { t: 'name'; v: string }
  | { t: 'arr'; v: Token[] }
  | { t: 'dict'; v: Record<string, Token> }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'op'; v: string }
  | { t: 'junk' };

export interface Op {
  op: string;
  operands: Token[];
  start: number;
  end: number;
  /** Inline images (BI … ID … EI) only. */
  dict?: Record<string, Token>;
  data?: Uint8Array;
}

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const isRegular = (c: number) => !WS.has(c) && !DELIM.has(c);
const ESCAPES: Record<number, number> = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 };

export function tokenize(bytes: Uint8Array): Op[] {
  let i = 0;
  const n = bytes.length;
  const ops: Op[] = [];
  let operands: Token[] = [];
  let opStart = -1;

  const skipWs = () => {
    for (;;) {
      while (i < n && WS.has(bytes[i])) i++;
      if (bytes[i] === 37) while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i++;
      else break;
    }
  };

  const readObj = (): Token | undefined => {
    skipWs();
    if (i >= n) return undefined;
    const c = bytes[i];
    if (c === 40) { // (literal string)
      i++;
      let depth = 1;
      const out: number[] = [];
      while (i < n && depth > 0) {
        const b = bytes[i++];
        if (b === 92) {
          const e = bytes[i++];
          if (e in ESCAPES) out.push(ESCAPES[e]);
          else if (e >= 48 && e <= 55) {
            let v = e - 48;
            for (let k = 0; k < 2 && bytes[i] >= 48 && bytes[i] <= 55; k++) v = v * 8 + bytes[i++] - 48;
            out.push(v & 255);
          } else if (e === 13) { if (bytes[i] === 10) i++; } else if (e !== 10) out.push(e); // \<eol> is a line continuation
          continue;
        }
        if (b === 40) depth++;
        else if (b === 41 && --depth === 0) break;
        out.push(b);
      }
      return { t: 'str', bytes: Uint8Array.from(out) };
    }
    if (c === 60 && bytes[i + 1] === 60) { // << dict >>
      i += 2;
      const d: Record<string, Token> = {};
      for (;;) {
        skipWs();
        if (i >= n) break;
        if (bytes[i] === 62 && bytes[i + 1] === 62) { i += 2; break; }
        const k = readObj();
        const v = readObj();
        if (k === undefined || v === undefined) break;
        if (k.t === 'name') d[k.v] = v;
      }
      return { t: 'dict', v: d };
    }
    if (c === 60) { // <hex string>
      i++;
      let hex = '';
      while (i < n && bytes[i] !== 62) { const ch = bytes[i++]; if (!WS.has(ch)) hex += String.fromCharCode(ch); }
      i++;
      if (hex.length % 2) hex += '0';
      const out = new Uint8Array(hex.length / 2);
      for (let k = 0; k < out.length; k++) out[k] = parseInt(hex.substr(k * 2, 2), 16) || 0;
      return { t: 'str', bytes: out, hex: true };
    }
    if (c === 91) { // [array]
      i++;
      const arr: Token[] = [];
      for (;;) {
        skipWs();
        if (i >= n) break;
        if (bytes[i] === 93) { i++; break; }
        const o = readObj();
        if (o === undefined) break;
        arr.push(o);
      }
      return { t: 'arr', v: arr };
    }
    if (c === 47) { // /name, with #xx escapes
      i++;
      let s = '';
      while (i < n && isRegular(bytes[i])) s += String.fromCharCode(bytes[i++]);
      return { t: 'name', v: s.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) };
    }
    let s = '';
    while (i < n && isRegular(bytes[i])) s += String.fromCharCode(bytes[i++]);
    if (s === '') { i++; return { t: 'junk' }; }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return { t: 'num', v: parseFloat(s) };
    if (s === 'true' || s === 'false') return { t: 'bool', v: s === 'true' };
    if (s === 'null') return { t: 'null' };
    return { t: 'op', v: s };
  };

  for (;;) {
    skipWs();
    if (i >= n) break;
    const start = i;
    const o = readObj();
    if (o === undefined) break;
    if (opStart < 0) opStart = start;
    if (o.t !== 'op') { operands.push(o); continue; }
    if (o.v === 'BI') { // inline image: dictionary up to ID, binary data up to EI
      const dict: Record<string, Token> = {};
      for (;;) {
        skipWs();
        if (i >= n) break;
        const save = i;
        const k = readObj();
        if (!k) break;
        if (k.t === 'op' && k.v === 'ID') break;
        if (k.t !== 'name') { i = save + 1; continue; }
        const v = readObj();
        if (v) dict[k.v] = v;
      }
      i++;
      const dataStart = i;
      let end = -1;
      for (let k = i; k < n - 2; k++) {
        if (WS.has(bytes[k]) && bytes[k + 1] === 69 && bytes[k + 2] === 73 && (k + 3 >= n || WS.has(bytes[k + 3]) || DELIM.has(bytes[k + 3]))) { end = k; break; }
      }
      if (end < 0) end = Math.max(dataStart, n - 2);
      const data = bytes.subarray(dataStart, end);
      i = end + 3;
      ops.push({ op: 'BI', operands: [], dict, data, start: opStart, end: Math.min(i, n) });
      operands = [];
      opStart = -1;
      continue;
    }
    ops.push({ op: o.v, operands, start: opStart, end: i });
    operands = [];
    opStart = -1;
  }
  return ops;
}

const hex = (b: Uint8Array) => '<' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') + '>';
const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''));

/** Serializes an operand for a rewritten operation. Strings always go out as hex. */
export function ser(o: Token | number): string {
  if (typeof o === 'number') return fmt(o);
  switch (o.t) {
    case 'num': return fmt(o.v);
    case 'str': return hex(o.bytes);
    case 'name': return '/' + o.v.replace(/[^!-~]|[#()<>[\]{}/%]/g, (ch) => '#' + ch.charCodeAt(0).toString(16).padStart(2, '0'));
    case 'arr': return '[' + o.v.map(ser).join(' ') + ']';
    case 'dict': return '<<' + Object.entries(o.v).map(([k, v]) => ser({ t: 'name', v: k }) + ' ' + ser(v)).join(' ') + '>>';
    case 'bool': return String(o.v);
    case 'null': return 'null';
    default: throw new Error(`cannot serialize a ${o.t} token`);
  }
}

/** Bytes → string, one char per byte. TextDecoder('latin1') is really windows-1252
 * and changes 0x80–0x9F; in the spike that corrupted MacRoman letters. */
export function binaryString(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 8192)));
  return s;
}
