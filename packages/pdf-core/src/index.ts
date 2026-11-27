// pdf-core: what both tools share. It runs in a Web Worker in the browser and
// in Node for the tests; it never touches the network.
export { openPdf, PasswordRequired, type Encryption, type Opened } from './open';
export { interpretPage, type Glyph, type PageRecord } from './interpret';
export { makeFontReader, glyphNameToUnicode, parseToUnicode, type FontInfo } from './fonts';
export { tokenize, ser, binaryString, type Op, type Token } from './tokenize';
export { sanitizedCopy, scrubResources, residue, PAGE_KEYS, XOBJECT_KEYS, type ScrubReport } from './sanitize';
export { assemble, parseRanges, groupLabel, PageRangeError, type PagePick, type TidyReport } from './structure';
export { dedupeStreams, collectGarbage } from './dedupe';
export { flattenAnnotations, type FlattenReport } from './flatten';
export { stripJpeg, jpegInfo, readExif, isJpeg, withoutIcc, type Stripped } from './jpeg';
export { compress, streamDigest, LEVELS, type ImageCodec, type Level, type CompressReport, type SkipReason } from './compress';
export { clean, type CleanReport } from './clean';
export { imagesToPdf, orientationMatrix, UnsupportedImage, type Paper, type ImagesReport } from './images';
export { mergeFiles, organizeFile, splitFile, imagesFile, compressFile, cleanFile, SourceError, type Source, type SplitMode } from './ops';
export * as objects from './objects';
