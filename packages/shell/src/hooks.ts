// Opening a PDF (with its password, when it has one) and drawing its pages.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Encryption } from '@pdf-core/open';
import { CoreError, inspect } from './core';
import { openForPreview, renderThumbnail } from './pdf';

export type PdfState =
  | { phase: 'empty' }
  | { phase: 'reading'; file: File }
  | { phase: 'password'; file: File; wrong: boolean }
  | { phase: 'ready'; id: number; file: File; password?: string; pages: number; encryption: Encryption }
  | { phase: 'failed'; file: File; message: string };

/** One PDF: choose it, unlock it if needed, and know its pages. */
export function usePdf() {
  const [state, setState] = useState<PdfState>({ phase: 'empty' });
  const turn = useRef(0);
  const open = useCallback(async (file: File, password?: string) => {
    const mine = ++turn.current;
    setState({ phase: 'reading', file });
    try {
      const info = await inspect(file, password);
      if (mine === turn.current) setState({ phase: 'ready', id: mine, file, password, pages: info.pages, encryption: info.encryption });
    } catch (e) {
      if (mine !== turn.current) return;
      const code = e instanceof CoreError ? e.code : 'failed';
      if (code === 'password' || code === 'wrong-password') setState({ phase: 'password', file, wrong: code === 'wrong-password' });
      else setState({ phase: 'failed', file, message: `${file.name} could not be read as a PDF.` });
    }
  }, []);
  const reset = useCallback(() => { turn.current++; setState({ phase: 'empty' }); }, []);
  return { state, open, reset };
}

/**
 * Thumbnails of every page, drawn one after another so the first ones show
 * while the rest are on their way. Blob URLs are revoked when the file changes.
 */
export function useThumbnails(file: Blob | null, password: string | undefined, width = 140, limit = Infinity) {
  const [shot, setShot] = useState<{ file: Blob | null; urls: string[]; failed: boolean }>({ file: null, urls: [], failed: false });
  useEffect(() => {
    if (!file) return;
    let alive = true;
    const made: string[] = [];
    (async () => {
      let preview;
      try {
        preview = await openForPreview(await file.arrayBuffer(), password);
        const n = Math.min(preview.doc.numPages, limit);
        for (let i = 1; i <= n && alive; i++) {
          const u = await renderThumbnail(preview.doc, i, width);
          if (!alive) { URL.revokeObjectURL(u); break; }
          made.push(u);
          setShot({ file, urls: [...made], failed: false });
        }
      } catch {
        if (alive) setShot({ file, urls: [...made], failed: true }); // the tools still work; only the preview is missing
      } finally {
        await preview?.close();
      }
    })();
    return () => { alive = false; made.forEach((u) => URL.revokeObjectURL(u)); };
  }, [file, password, width, limit]);
  return shot.file === file ? shot : { urls: [], failed: false };
}

/** One page of a PDF (a file, or a result held in memory), drawn once. */
export function usePagePreview(source: Blob | ArrayBuffer | null, page = 1, width = 280, password?: string) {
  const [shot, setShot] = useState<{ source: Blob | ArrayBuffer | null; url: string | null }>({ source: null, url: null });
  useEffect(() => {
    if (!source) return;
    let alive = true;
    let made: string | null = null;
    (async () => {
      let preview;
      try {
        preview = await openForPreview(source instanceof Blob ? await source.arrayBuffer() : source, password);
        const u = await renderThumbnail(preview.doc, Math.min(page, preview.doc.numPages), width);
        if (alive) { made = u; setShot({ source, url: u }); } else URL.revokeObjectURL(u);
      } catch { /* no preview */ } finally {
        await preview?.close();
      }
    })();
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [source, page, width, password]);
  return shot.source === source ? shot.url : null;
}
