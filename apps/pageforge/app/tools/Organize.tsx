import { useState } from 'react';
import { Download, EncryptionNotice, baseName, plural, run, usePdf, useThumbnails, type PdfState } from '@shell';
import { JobStatus, PdfInput, move, useJob, useReorder } from '../parts';

type Card = { key: number; page: number; rotate: number };
const fresh = (n: number): Card[] => Array.from({ length: n }, (_, i) => ({ key: i, page: i, rotate: 0 }));

export function Organize() {
  const pdf = usePdf();
  return (
    <section className="tool">
      <PdfInput pdf={pdf} />
      {pdf.state.phase === 'ready' && <Pages key={pdf.state.id} ready={pdf.state} />}
    </section>
  );
}

function Pages({ ready }: { ready: Extract<PdfState, { phase: 'ready' }> }) {
  const [cards, setCards] = useState<Card[]>(() => fresh(ready.pages));
  const { job, start, reset } = useJob<'organize'>();
  const { urls } = useThumbnails(ready.file, ready.password);
  const change = (next: Card[]) => { reset(); setCards(next); };
  const { props, over } = useReorder((from, to) => change(move(cards, from, to)));

  const turn = (i: number, by: number) => change(cards.map((c, k) => (k === i ? { ...c, rotate: (c.rotate + by + 360) % 360 } : c)));
  const deleted = ready.pages - cards.length;
  const changed = deleted > 0 || cards.some((c, i) => c.page !== i || c.rotate !== 0);

  async function save() {
    await start('Saving', async () => {
      const bytes = await ready.file.arrayBuffer();
      return run({ type: 'organize', file: { bytes, password: ready.password }, pages: cards.map(({ page, rotate }) => ({ page, rotate })) }, [bytes]);
    });
  }

  return (
    <>
      <p className="muted">
        {plural(cards.length, 'page')}{deleted > 0 ? ` · ${deleted} deleted` : ''}. Drag pages to reorder them, or use the buttons under each one.
        {changed && <> <button type="button" className="link" onClick={() => change(fresh(ready.pages))} data-testid="reset">Start over</button></>}
      </p>
      <ol className="pages" data-testid="pages">
        {cards.map((c, i) => (
          <li key={c.key} className={`page-card${over === i ? ' over' : ''}`} data-testid="page" {...props(i)}>
            <div className="page-thumb">
              {urls[c.page] ? <img src={urls[c.page]} alt={`Page ${c.page + 1}`} className={`rot-${c.rotate}`} draggable={false} /> : <span className="placeholder" />}
            </div>
            <span className="page-label">Page {c.page + 1}{c.rotate ? ` · ${c.rotate}°` : ''}</span>
            <span className="actions">
              <button type="button" aria-label={`Rotate page ${c.page + 1} left`} data-testid="rotate-left" onClick={() => turn(i, -90)}>↺</button>
              <button type="button" aria-label={`Rotate page ${c.page + 1} right`} data-testid="rotate-right" onClick={() => turn(i, 90)}>↻</button>
              <button type="button" aria-label={`Move page ${c.page + 1} earlier`} data-testid="move-earlier" disabled={i === 0} onClick={() => change(move(cards, i, i - 1))}>←</button>
              <button type="button" aria-label={`Move page ${c.page + 1} later`} data-testid="move-later" disabled={i === cards.length - 1} onClick={() => change(move(cards, i, i + 1))}>→</button>
              <button type="button" aria-label={`Delete page ${c.page + 1}`} data-testid="delete" disabled={cards.length === 1} onClick={() => change(cards.filter((_, k) => k !== i))}>✕</button>
            </span>
          </li>
        ))}
      </ol>
      <div className="run">
        <button type="button" className="primary" disabled={!changed || job.phase === 'working'} onClick={() => void save()} data-testid="run">Save the new PDF</button>
      </div>
      <JobStatus job={job} />
      {job.phase === 'done' && (
        <Download bytes={job.output.bytes} name={`${baseName(ready.file.name)}-organized.pdf`} mime={job.output.mime}>
          <ul className="report" data-testid="report">
            <li>{plural(job.output.report.pages, 'page')}.</li>
            {job.output.report.linksRemoved > 0 && <li>{plural(job.output.report.linksRemoved, 'link')} to deleted pages removed.</li>}
            {job.output.report.actionsRemoved > 0 && <li>{plural(job.output.report.actionsRemoved, 'script or action')} that would run code removed.</li>}
          </ul>
          <EncryptionNotice encryption={job.output.report.encryption} />
        </Download>
      )}
    </>
  );
}
