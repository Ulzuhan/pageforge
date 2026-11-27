import { useEffect, useRef, useState } from 'react';
import { inspect, CoreError, type Inspection } from './core';
import { openForPreview, renderThumbnail } from './pdf';
import { FilePicker, PasswordPrompt } from './ui';

type State =
  | { phase: 'idle' }
  | { phase: 'working'; name: string }
  | { phase: 'password'; name: string; wrong: boolean }
  | { phase: 'done'; name: string; size: number; info: Inspection; thumbs: string[] }
  | { phase: 'failed'; name: string; message: string };

const THUMBS = 6;

/**
 * InkBar's editor until F4: open a PDF and see what the tool sees — pages,
 * encryption, producer, and every glyph read by pdf-core — with pdf.js
 * thumbnails. Nothing is changed or saved.
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
    let info: Inspection;
    try {
      info = await inspect(f, password, true);
    } catch (e) {
      const code = e instanceof CoreError ? e.code : 'failed';
      if (code === 'password' || code === 'wrong-password') setState({ phase: 'password', name: f.name, wrong: code === 'wrong-password' });
      else setState({ phase: 'failed', name: f.name, message: 'This file could not be read as a PDF.' });
      return;
    }
    try {
      const { doc, close } = await openForPreview(await f.arrayBuffer(), password);
      for (let i = 1; i <= Math.min(THUMBS, doc.numPages); i++) thumbs.current.push(await renderThumbnail(doc, i));
      await close();
    } catch {
      // the inspection stands on its own; a preview that fails is not fatal
    }
    setState({ phase: 'done', name: f.name, size: f.size, info, thumbs: [...thumbs.current] });
  }

  return (
    <section className="tool">
      <p className="intro">{intro}</p>
      <FilePicker accept="application/pdf,.pdf" label="Choose a PDF" onFiles={([f]) => { file.current = f; void run(f); }} />

      {state.phase === 'working' && <p className="status" data-testid="status">Reading {state.name}…</p>}
      {state.phase === 'password' && (
        <PasswordPrompt name={state.name} wrong={state.wrong} onSubmit={(pw) => { if (file.current) void run(file.current, pw); }} />
      )}
      {state.phase === 'failed' && <p className="status error" data-testid="status">{state.message}</p>}

      {state.phase === 'done' && (
        <div className="report" data-testid="result">
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
