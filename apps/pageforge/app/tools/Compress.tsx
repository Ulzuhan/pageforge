import { useState } from 'react';
import { Download, EncryptionNotice, Notice, baseName, plural, run, size, usePagePreview, usePdf, type PdfState } from '@shell';
import type { Level, SkipReason } from '@pdf-core/compress';
import { JobStatus, PdfInput, useJob } from '../parts';

const LEVELS: { id: Level; label: string; hint: string }[] = [
  { id: 'lossless', label: 'Lossless', hint: 'Nothing you can see changes. Repacks the file; best for documents saved by older programs.' },
  { id: 'medium', label: 'Medium', hint: 'Photos and scans as JPEG at good quality, no sharper than 150 ppi as printed. Right for most uses.' },
  { id: 'strong', label: 'Strong', hint: 'Smaller still: 100 ppi and lower quality. Fine on screen; text in scans may look soft.' },
];

const SKIPPED: Record<SkipReason, string> = {
  mask: 'masks and transparency', filter: 'formats we do not recompress (JPEG 2000, JBIG2, fax)', bits: 'images that are not 8-bit',
  colorspace: 'CMYK, indexed or special colours', 'icc-components': 'colour profiles that are not RGB', 'decode-array': 'unusual encodings',
  'color-key-mask': 'unusual encodings', matte: 'unusual encodings', predictor: 'unusual encodings', components: 'unusual encodings',
  'too-large': 'too large to decode in a tab', unreadable: 'images that could not be decoded',
};

export function Compress() {
  const pdf = usePdf();
  return (
    <section className="tool">
      <PdfInput pdf={pdf} />
      {pdf.state.phase === 'ready' && <Levels key={pdf.state.id} ready={pdf.state} />}
    </section>
  );
}

function Levels({ ready }: { ready: Extract<PdfState, { phase: 'ready' }> }) {
  const [level, setLevelRaw] = useState<Level>('medium');
  const { job, start, reset } = useJob<'compress'>();
  const setLevel = (l: Level) => { reset(); setLevelRaw(l); };

  const out = job.phase === 'done' ? job.output : null;
  const before = usePagePreview(out && !out.report.unchanged ? ready.file : null, 1, 260, ready.password);
  const after = usePagePreview(out && !out.report.unchanged ? out.bytes : null, 1, 260);

  async function go() {
    await start('Compressing', async (progress) => {
      const bytes = await ready.file.arrayBuffer();
      return run({ type: 'compress', file: { bytes, password: ready.password }, level }, [bytes], progress);
    });
  }

  const r = out?.report;
  const gain = r ? 1 - r.after / r.before : 0;
  const skipped = r ? [...new Set(Object.keys(r.images.skipped).map((k) => SKIPPED[k as SkipReason]))] : [];
  const skippedCount = r ? Object.values(r.images.skipped).reduce((a, b) => a + (b ?? 0), 0) : 0;

  return (
    <>
      <fieldset className="choices">
        <legend>How much</legend>
        {LEVELS.map((l) => (
          <label key={l.id} className="choice">
            <input type="radio" name="level" value={l.id} checked={level === l.id} onChange={() => setLevel(l.id)} data-testid={`level-${l.id}`} />
            <span><strong>{l.label}</strong><span className="muted">{l.hint}</span></span>
          </label>
        ))}
      </fieldset>
      <div className="run">
        <button type="button" className="primary" disabled={job.phase === 'working'} onClick={() => void go()} data-testid="run">Compress</button>
      </div>
      <JobStatus job={job} />
      {out && r && (r.unchanged || gain < 0.05) && (
        <Notice>
          {r.unchanged
            ? 'Compressing would not make this PDF smaller'
            : 'This PDF was already about as compressed as we can make it'} {level === 'lossless' ? 'without losing quality' : 'at this level'}
          {r.unchanged ? ', so there is nothing new to download: keep the one you have' : ''}.{level !== 'strong' && ' A stronger level may still help.'}
        </Notice>
      )}
      {out && r && !r.unchanged && (
        <Download bytes={out.bytes} name={`${baseName(ready.file.name)}-compressed.pdf`} mime={out.mime}>
          <p className="gain" data-testid="gain">
            <span data-testid="before">{size(r.before)}</span> → <strong data-testid="after">{size(r.after)}</strong>
            {' '}({Math.round(gain * 100)} % smaller)
          </p>
          <ul className="report" data-testid="report">
            {r.images.replaced > 0 && <li>{plural(r.images.replaced, 'image')} recompressed{r.images.downscaled ? `, ${r.images.downscaled} of them at a lower resolution` : ''}.</li>}
            {r.images.notSmaller > 0 && <li>{plural(r.images.notSmaller, 'image')} left as {r.images.notSmaller === 1 ? 'it was' : 'they were'}: recompressing would not have made {r.images.notSmaller === 1 ? 'it' : 'them'} smaller.</li>}
            {skippedCount > 0 && <li>{plural(skippedCount, 'image')} not touched: {skipped.join(', ')}.</li>}
            {r.streams.recompressed > 0 && <li>{plural(r.streams.recompressed, 'part')} of the file packed more tightly.</li>}
            {r.duplicates > 0 && <li>{plural(r.duplicates, 'duplicate')} stored once.</li>}
          </ul>
          <EncryptionNotice encryption={[r.encryption]} />
          {(before || after) && (
            <div className="compare">
              <figure>{before && <img src={before} alt="First page before" />}<figcaption>Before</figcaption></figure>
              <figure>{after && <img src={after} alt="First page after" />}<figcaption>After</figcaption></figure>
            </div>
          )}
        </Download>
      )}
    </>
  );
}
