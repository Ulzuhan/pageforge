import { useEffect, useRef, useState } from 'react';
import type { CoreResponse } from '@pdf-core/worker';
import { inspect, openForPreview, renderThumbnail } from './pdf';

type State =
  | { phase: 'idle' }
  | { phase: 'working'; name: string }
  | { phase: 'password'; name: string; wrong: boolean }
  | { phase: 'done'; name: string; size: number; info: Extract<CoreResponse, { ok: true }>; thumbs: string[] }
  | { phase: 'failed'; name: string; message: string };

const THUMBS = 6;

/**
 * F2's empty editor: open a PDF and see what the tools see — pages, encryption,
 * producer, and every glyph read by pdf-core — with pdf.js thumbnails. Nothing
 * is changed or saved yet; the tools themselves arrive in F3 and F4.
 */
export function Inspector({ intro }: { intro: string }) {
  const [state, setState] = useState<State>({ phase: 'idle' });
  const file = useRef<File | null>(null);
  const thumbs = useRef<string[]>([]);

  useEffect(() => () => thumbs.current.forEach((u) => URL.revokeObjectURL(u)), []);

  async function run(f: File, password?: string) {
    thumbs.current.forEach((u) => URL.revokeObjectURL(u));
    thumbs.current = [];
    setState({ phase: 'working', name: f.name });
    const bytes = await f.arrayBuffer();
    const info = await inspect(bytes, password);
    if (!info.ok) {
      if (info.error === 'password' || info.error === 'wrong-password') setState({ phase: 'password', name: f.name, wrong: info.error === 'wrong-password' });
      else setState({ phase: 'failed', name: f.name, message: 'This file could not be read as a PDF.' });
      return;
    }
    try {
      const { doc, close } = await openForPreview(bytes, password);
      for (let i = 1; i <= Math.min(THUMBS, doc.numPages); i++) thumbs.current.push(await renderThumbnail(doc, i));
      await close();
    } catch {
      // the inspection stands on its own; a preview that fails is not fatal
    }
    setState({ phase: 'done', name: f.name, size: f.size, info, thumbs: [...thumbs.current] });
  }

  return (
    <section className="inspector">
      <p className="intro">{intro}</p>
      <label className="drop">
        <input type="file" accept="application/pdf,.pdf" data-testid="file"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) { file.current = f; void run(f); } }} />
        <span>Choose a PDF</span>
      </label>

      {state.phase === 'working' && <p className="status" data-testid="status">Reading {state.name}…</p>}

      {state.phase === 'password' && (
        <form className="password" onSubmit={(e) => {
          e.preventDefault();
          const pw = new FormData(e.currentTarget).get('password');
          if (file.current && typeof pw === 'string') void run(file.current, pw);
        }}>
          <p>{state.wrong ? 'That password did not open it. Try again:' : `${state.name} needs a password to open.`}</p>
          <input name="password" type="password" autoComplete="off" data-testid="password" />
          <button type="submit">Open</button>
        </form>
      )}

      {state.phase === 'failed' && <p className="status error" data-testid="status">{state.message}</p>}

      {state.phase === 'done' && (
        <div className="result" data-testid="result">
          <dl>
            <dt>File</dt><dd>{state.name} · {(state.size / 1024).toFixed(0)} kB</dd>
            <dt>Pages</dt><dd data-testid="pages">{state.info.pages}</dd>
            <dt>Producer</dt><dd>{state.info.producer || 'not stated'}</dd>
            <dt>Encryption</dt><dd data-testid="encryption">{
              state.info.encryption === 'none' ? 'none'
                : state.info.encryption === 'owner-password-only' ? 'restrictions set by the author (a copy would come out without them)'
                  : 'password to open'}</dd>
            <dt>Text read</dt><dd data-testid="glyphs">{state.info.summary.reduce((a, p) => a + p.glyphs, 0)} glyphs
              {state.info.summary.some((p) => p.unreadable) && ` (${state.info.summary.reduce((a, p) => a + p.unreadable, 0)} without a known letter)`}
              {' '}in {state.info.ms} ms</dd>
          </dl>
          <div className="thumbs" data-testid="thumbs">
            {state.thumbs.map((u, i) => <img key={u} src={u} alt={`Page ${i + 1}`} />)}
          </div>
        </div>
      )}
    </section>
  );
}
