import { useMemo, useState } from 'react';
import { Download, EncryptionNotice, baseName, plural, run, usePdf, useThumbnails, type PdfState } from '@shell';
import { PageRangeError, parseRanges } from '@pdf-core/ranges';
import type { SplitMode } from '@pdf-core/ops';
import { JobStatus, PdfInput, useJob } from '../parts';

const MODES: { id: SplitMode; label: string; hint: string }[] = [
  { id: 'extract', label: 'Take pages out', hint: 'The pages you list, in that order, in one new PDF.' },
  { id: 'ranges', label: 'One file per range', hint: 'Each part between commas becomes its own PDF; you get a zip.' },
  { id: 'every', label: 'One file per page', hint: 'Every page becomes its own PDF; you get a zip.' },
];

export function Split() {
  const pdf = usePdf();
  return (
    <section className="tool">
      <PdfInput pdf={pdf} />
      {pdf.state.phase === 'ready' && <Options key={pdf.state.id} ready={pdf.state} />}
    </section>
  );
}

function Options({ ready }: { ready: Extract<PdfState, { phase: 'ready' }> }) {
  const [mode, setModeRaw] = useState<SplitMode>('extract');
  const [ranges, setRangesRaw] = useState('');
  const { job, start, reset } = useJob<'split'>();
  const { urls } = useThumbnails(ready.file, ready.password, 96, 300);
  const setMode = (m: SplitMode) => { reset(); setModeRaw(m); };
  const setRanges = (r: string) => { reset(); setRangesRaw(r); };

  const check = useMemo(() => {
    if (mode === 'every') return { groups: null as number[][] | null, error: '' };
    if (!ranges.trim()) return { groups: null, error: '' };
    try { return { groups: parseRanges(ranges, ready.pages), error: '' }; } catch (e) {
      return { groups: null, error: e instanceof PageRangeError ? e.message : String(e) };
    }
  }, [ready.pages, mode, ranges]);
  const can = mode === 'every' ? ready.pages > 1 : !!check.groups;

  async function split() {
    await start('Splitting', async () => {
      const bytes = await ready.file.arrayBuffer();
      return run({ type: 'split', file: { bytes, password: ready.password }, mode, ranges, base: baseName(ready.file.name) }, [bytes]);
    });
  }

  const summary = check.groups
    ? mode === 'extract' ? `${plural(check.groups.flat().length, 'page')} into one PDF.` : `${plural(check.groups.length, 'PDF')}, in a zip.`
    : mode === 'every' ? `${plural(ready.pages, 'PDF')}, in a zip.` : '';

  return (
    <>
      <fieldset className="choices">
        <legend>How</legend>
        {MODES.map((m) => (
          <label key={m.id} className="choice">
            <input type="radio" name="mode" value={m.id} checked={mode === m.id} onChange={() => setMode(m.id)} data-testid={`mode-${m.id}`} />
            <span><strong>{m.label}</strong><span className="muted">{m.hint}</span></span>
          </label>
        ))}
      </fieldset>
      {mode !== 'every' && (
        <label className="field">
          <span>Pages</span>
          <input type="text" value={ranges} onChange={(e) => setRanges(e.target.value)} placeholder="1-3, 7, 9-" inputMode="numeric"
            aria-describedby="ranges-help" aria-invalid={!!check.error} data-testid="ranges" />
          <span id="ranges-help" className={check.error ? 'error' : 'muted'}>{check.error || `Pages 1 to ${ready.pages}. Use commas between parts and a dash for a range.`}</span>
        </label>
      )}
      <div className="run">
        <button type="button" className="primary" disabled={!can || job.phase === 'working'} onClick={() => void split()} data-testid="run">Split</button>
        {summary && <span className="muted">{summary}</span>}
      </div>
      <JobStatus job={job} />
      {job.phase === 'done' && (
        <Download bytes={job.output.bytes} name={job.output.name ?? 'split.pdf'} mime={job.output.mime}>
          <ul className="report" data-testid="report">
            {job.output.report.files.slice(0, 12).map((f) => <li key={f.name}>{f.name} · {plural(f.pages, 'page')}</li>)}
            {job.output.report.files.length > 12 && <li>… and {job.output.report.files.length - 12} more.</li>}
          </ul>
          <EncryptionNotice encryption={job.output.report.encryption} />
        </Download>
      )}
      {urls.length > 0 && (
        <ol className="pages small" aria-label="Pages">
          {urls.map((u, i) => <li key={u} className="page-card"><div className="page-thumb"><img src={u} alt={`Page ${i + 1}`} /></div><span className="page-label">{i + 1}</span></li>)}
        </ol>
      )}
    </>
  );
}
