import { describe, expect, it } from 'vitest';
import { binaryString, ser, tokenize } from '@pdf-core/tokenize';

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const text = (b: Uint8Array) => String.fromCharCode(...b);

describe('tokenize', () => {
  it('reads literal strings with escapes, octal, nesting and line continuations', () => {
    const [op] = tokenize(enc('(a\\(b\\)c \\101\\12 (nested) x\\\ny) Tj'));
    expect(op.op).toBe('Tj');
    const s = op.operands[0];
    expect(s.t).toBe('str');
    if (s.t === 'str') expect(text(s.bytes)).toBe('a(b)c A\n (nested) xy');
  });

  it('reads hex strings, padding an odd final digit', () => {
    const [op] = tokenize(enc('<48 65 6c6C 6>Tj'));
    const s = op.operands[0];
    if (s.t === 'str') expect(Array.from(s.bytes)).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x60]);
  });

  it('keeps byte ranges so untouched operations can be copied verbatim', () => {
    const src = 'BT /F1 12 Tf 10 20 Td [(A) -250 (B)] TJ ET';
    const ops = tokenize(enc(src));
    expect(ops.map((o) => o.op)).toEqual(['BT', 'Tf', 'Td', 'TJ', 'ET']);
    expect(src.slice(ops[3].start, ops[3].end)).toBe('[(A) -250 (B)] TJ');
    const tj = ops[3].operands[0];
    expect(tj.t === 'arr' && tj.v.map((e) => e.t)).toEqual(['str', 'num', 'str']);
  });

  it('decodes #xx in names and skips comments', () => {
    const ops = tokenize(enc('% comment\n/Fm#201 Do'));
    expect(ops[0].operands[0]).toEqual({ t: 'name', v: 'Fm 1' });
  });

  it('reads inline images up to EI without parsing their data as operators', () => {
    const ops = tokenize(enc('q BI /W 2 /H 1 /BPC 8 /CS /G ID \x00EI\xff EI Q'));
    expect(ops.map((o) => o.op)).toEqual(['q', 'BI', 'Q']);
    expect(ops[1].dict?.W).toEqual({ t: 'num', v: 2 });
    expect(Array.from(ops[1].data!)).toEqual([0x00, 0x45, 0x49, 0xff]);
  });

  it('survives garbage without throwing', () => {
    expect(() => tokenize(enc(')(<<]]>> /\x00 [ ( '))).not.toThrow();
    expect(() => tokenize(new Uint8Array(1000).map((_, i) => (i * 37) & 255))).not.toThrow();
  });

  it('serializes operands, strings always as hex', () => {
    expect(ser({ t: 'arr', v: [{ t: 'str', bytes: enc('A)') }, { t: 'num', v: -250.5 }, { t: 'name', v: 'F 1' }] }))
      .toBe('[<4129> -250.5 /F#201]');
    expect(ser(1 / 3)).toBe('0.3333');
  });

  it('maps bytes to chars one to one, 0x80–0x9F included', () => {
    const b = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(Array.from(binaryString(b), (c) => c.charCodeAt(0))).toEqual(Array.from(b));
  });
});
