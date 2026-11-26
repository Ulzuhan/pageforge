// pdf-core: what both tools share. It runs in a Web Worker in the browser and
// in Node for the tests; it never touches the network.
export { openPdf, PasswordRequired, type Encryption, type Opened } from './open';
export { interpretPage, type Glyph, type PageRecord } from './interpret';
export { makeFontReader, glyphNameToUnicode, parseToUnicode, type FontInfo } from './fonts';
export { tokenize, ser, binaryString, type Op, type Token } from './tokenize';
export { sanitizedCopy, scrubResources, residue, PAGE_KEYS, XOBJECT_KEYS, type ScrubReport } from './sanitize';
export * as objects from './objects';
