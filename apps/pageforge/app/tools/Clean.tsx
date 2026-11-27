import { Download, EncryptionNotice, baseName, plural, run, usePdf, type PdfState } from '@shell';
import type { CleanReport } from '@pdf-core/clean';
import { JobStatus, PdfInput, useJob, where } from '../parts';

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
const KIND: Record<string, string> = { Widget: 'form field', FreeText: 'text box', Stamp: 'stamp', Ink: 'drawing', Square: 'shape', Circle: 'shape', Highlight: 'highlight', Text: 'note' };
const kinds = (r: Record<string, number>) => Object.entries(r).map(([k, n]) => plural(n, KIND[k] ?? 'annotation')).join(', ');

/** What was there, in words, one line per thing found. */
function findings(r: CleanReport): string[] {
  const f = r.found, out: string[] = [];
  if (f.info.length) out.push(`Document details: ${f.info.join(', ')}.`);
  if (f.xmp) out.push(`${plural(f.xmp, 'block')} of XMP metadata (author, software, history).`);
  if (r.jpeg.cleaned) out.push(`Camera data in ${plural(r.jpeg.cleaned, 'photo')}${where(r.jpeg.gps, r.jpeg.cleaned)}.`);
  if (f.attachments) out.push(`${plural(f.attachments, 'attached file')}.`);
  if (f.javascript) out.push(`${plural(f.javascript, 'script')} (JavaScript).`);
  if (f.openAction) out.push('An action that runs when the file is opened.');
  if (f.formFields) out.push(`${plural(f.formFields, 'form field')}: their values stay on the page, the form stops being fillable.`);
  // Form fields are told above; the rest of what was drawn in, here.
  const drawn = Object.fromEntries(Object.entries(r.annotations.flattened).filter(([k]) => k !== 'Widget' || !f.formFields));
  if (sum(drawn)) out.push(`${kinds(drawn)}: drawn into the page, as ${sum(drawn) === 1 ? 'it' : 'they'} looked.`);
  if (sum(r.annotations.dropped)) out.push(`${plural(sum(r.annotations.dropped), 'hidden annotation')}, removed.`);
  if (sum(r.annotations.removed)) out.push(`${plural(sum(r.annotations.removed), 'link or comment pop-up')}, removed.`);
  if (f.bookmarks) out.push('Bookmarks.');
  if (f.tags) out.push('Accessibility tags (structure tree).');
  if (f.earlierVersions) out.push(`${plural(f.earlierVersions, 'earlier version')} of the file, kept inside it by incremental saves.`);
  if (r.privateKeys) out.push(`${plural(r.privateKeys, 'piece')} of private data left by design programs.`);
  if (r.unusedResources) out.push(`${plural(r.unusedResources, 'image or drawing')} that no page shows.`);
  return out;
}

export function Clean() {
  const pdf = usePdf();
  return (
    <section className="tool">
      <PdfInput pdf={pdf} />
      {pdf.state.phase === 'ready' && <Run key={pdf.state.id} ready={pdf.state} />}
    </section>
  );
}

function Run({ ready }: { ready: Extract<PdfState, { phase: 'ready' }> }) {
  const { job, start } = useJob<'clean'>();

  async function go() {
    await start('Cleaning', async () => {
      const bytes = await ready.file.arrayBuffer();
      return run({ type: 'clean', file: { bytes, password: ready.password } }, [bytes]);
    });
  }
  const list = job.phase === 'done' ? findings(job.output.report) : [];

  return (
    <>
      <p className="muted">The clean copy is a new PDF built from what the pages show. Everything else stays behind, and the result is checked again before you get it.</p>
      <div className="run">
        <button type="button" className="primary" disabled={job.phase === 'working'} onClick={() => void go()} data-testid="run">Clean</button>
      </div>
      <JobStatus job={job} />
      {job.phase === 'done' && (
        <Download bytes={job.output.bytes} name={`${baseName(ready.file.name)}-clean.pdf`} mime={job.output.mime}>
          <h3>{list.length ? 'Found and removed' : 'Nothing to remove'}</h3>
          <ul className="report" data-testid="report">
            {list.length ? list.map((l) => <li key={l}>{l}</li>) : <li>This PDF carried nothing besides its pages. The copy is clean all the same.</li>}
          </ul>
          <EncryptionNotice encryption={[job.output.report.encryption]} />
        </Download>
      )}
    </>
  );
}
