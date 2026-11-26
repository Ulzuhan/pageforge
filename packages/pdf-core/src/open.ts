// Opening a PDF. Always with updateMetadata: false (otherwise pdf-lib rewrites
// /Producer on load, and the tools would lie about where a file came from).
//
// Encryption, with the @cantoo fork (spike, P8):
//  - owner password only («restrictions»): it opens with the empty user
//    password. The tools say so: the author asked for the file not to be
//    changed, and the copy comes out without encryption.
//  - user password: asked for; without it, the file cannot be opened.
import { PDFDocument } from '@cantoo/pdf-lib';

export type Encryption = 'none' | 'owner-password-only' | 'user-password';

export interface Opened {
  doc: PDFDocument;
  encryption: Encryption;
  producer: string;
  pages: number;
}

export class PasswordRequired extends Error {
  constructor(readonly wrongPassword: boolean) {
    super(wrongPassword ? 'wrong password' : 'this PDF needs a password to open');
  }
}

const encrypted = (e: unknown) => /encrypt|password/i.test(String((e as Error)?.message ?? e));

export async function openPdf(bytes: Uint8Array, password?: string): Promise<Opened> {
  const done = (doc: PDFDocument, encryption: Encryption): Opened => ({
    doc, encryption, pages: doc.getPageCount(),
    producer: [doc.getProducer(), doc.getCreator()].filter(Boolean).join(' · '),
  });
  try {
    return done(await PDFDocument.load(bytes, { updateMetadata: false }), 'none');
  } catch (e) {
    if (!encrypted(e)) throw e;
  }
  try {
    return done(await PDFDocument.load(bytes, { updateMetadata: false, password: '' }), 'owner-password-only');
  } catch (e) {
    if (!encrypted(e)) throw e;
  }
  if (password === undefined) throw new PasswordRequired(false);
  try {
    return done(await PDFDocument.load(bytes, { updateMetadata: false, password }), 'user-password');
  } catch (e) {
    if (encrypted(e)) throw new PasswordRequired(true);
    throw e;
  }
}
