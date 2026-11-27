// Types for fixtures.mjs, so the TypeScript tests can import it.
export const MARKERS: Record<'exif' | 'comment' | 'xmp' | 'author' | 'title' | 'attachment' | 'js' | 'piece' | 'field' | 'note' | 'hidden' | 'other', string>;
export function rng(seed?: number): () => number;
export function insertSegment(jpeg: Uint8Array, seg: Uint8Array): Uint8Array;
export function exifApp1(o?: { orientation?: number; gps?: boolean; description?: string }): Uint8Array;
export function xmpApp1(): Uint8Array;
export function comSegment(): Uint8Array;
export function photoJpeg(w: number, h: number, o?: { quality?: number; seed?: number; exif?: { orientation?: number; gps?: boolean }; meta?: boolean }): Uint8Array;
export function quadrantJpeg(w: number, h: number, orientation: number): Uint8Array;
export function photoPng(w: number, h: number, o?: { alpha?: boolean; seed?: number }): Uint8Array;
export function srgbProfile(): Uint8Array;
export function labelledPdf(labels: string[], o?: { sizes?: [number, number][]; link?: boolean; risky?: boolean }): Promise<Uint8Array>;
export function photoPdf(o?: { count?: number; px?: [number, number]; quality?: number }): Promise<Uint8Array>;
export function scanPdf(o?: { pages?: number; rgb?: boolean; w?: number; arrays?: boolean }): Promise<Uint8Array>;
export function textPdf(o?: { pages?: number }): Promise<Uint8Array>;
export function zooPdf(): Promise<{ bytes: Uint8Array; refs: Record<'cmyk' | 'indexed' | 'sixteen' | 'decode' | 'iccGray' | 'masked' | 'icc', string>; smask: string }>;
export function formPdf(o?: { appearances?: boolean }): Promise<Uint8Array>;
export function cleanSamplePdf(): Promise<Uint8Array>;
export function everything(bytes: Uint8Array): Promise<string>;
