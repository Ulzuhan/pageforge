import { useEffect, useState } from 'react';
import { Download, FilePicker, SizeNotice, plural, run, size } from '@shell';
import type { Paper } from '@pdf-core/images';
import { JobStatus, move, useJob, useReorder, where } from '../parts';

type Item = { id: number; file: File; url: string };
let ids = 0;

export function Images() {
  const [items, setItems] = useState<Item[]>([]);
  const [paper, setPaper] = useState<Paper>('a4');
  const { job, start, reset } = useJob<'images'>();
  // previews are blob URLs of the files themselves; revoked when they go
  useEffect(() => () => items.forEach((it) => URL.revokeObjectURL(it.url)), [items]);
  const set = (next: Item[]) => { reset(); setItems(next.map((it) => ({ ...it, url: URL.createObjectURL(it.file) }))); };
  const { props, over } = useReorder((from, to) => set(move(items, from, to)));

  async function make() {
    await start('Making the PDF', async () => {
      const images = await Promise.all(items.map((it) => it.file.arrayBuffer()));
      return run({ type: 'images', images, paper }, images);
    });
  }

  return (
    <section className="tool">
      <FilePicker accept="image/jpeg,image/png,.jpg,.jpeg,.png" multiple label={items.length ? 'Add more images' : 'Choose JPEG or PNG images, or drop them here'}
        hint="One page each. Location and camera data are removed from photos." onFiles={(files) => set([...items, ...files.map((file) => ({ id: ++ids, file, url: '' }))])} />
      {items.length > 0 && (
        <>
          <ol className="pages" data-testid="images-list">
            {items.map((it, i) => (
              <li key={it.id} className={`page-card${over === i ? ' over' : ''}`} {...props(i)}>
                <div className="page-thumb"><img src={it.url} alt={it.file.name} draggable={false} /></div>
                <span className="page-label">{it.file.name} · {size(it.file.size)}</span>
                <span className="actions">
                  <button type="button" aria-label={`Move ${it.file.name} earlier`} disabled={i === 0} onClick={() => set(move(items, i, i - 1))}>←</button>
                  <button type="button" aria-label={`Move ${it.file.name} later`} disabled={i === items.length - 1} onClick={() => set(move(items, i, i + 1))}>→</button>
                  <button type="button" aria-label={`Remove ${it.file.name}`} onClick={() => set(items.filter((x) => x.id !== it.id))}>✕</button>
                </span>
              </li>
            ))}
          </ol>
          <SizeNotice bytes={items.reduce((a, it) => a + it.file.size, 0)} />
          <label className="field inline">
            <span>Page size</span>
            <select value={paper} onChange={(e) => { reset(); setPaper(e.target.value as Paper); }} data-testid="paper">
              <option value="a4">A4, turned to fit each image</option>
              <option value="letter">US Letter, turned to fit each image</option>
              <option value="image">The size of each image</option>
            </select>
          </label>
          <div className="run">
            <button type="button" className="primary" disabled={job.phase === 'working'} onClick={() => void make()} data-testid="run">
              Make a PDF of {plural(items.length, 'image')}
            </button>
          </div>
        </>
      )}
      <JobStatus job={job} />
      {job.phase === 'done' && (
        <Download bytes={job.output.bytes} name="images.pdf" mime={job.output.mime}>
          <ul className="report" data-testid="report">
            <li>{plural(job.output.report.pages, 'page')}.</li>
            {job.output.report.turned > 0 && <li>{plural(job.output.report.turned, 'photo')} turned upright, as the camera recorded it.</li>}
            {job.output.report.jpegMetadataRemoved > 0 && (
              <li>Camera data removed from {plural(job.output.report.jpegMetadataRemoved, 'photo')}{where(job.output.report.gpsRemoved, job.output.report.jpegMetadataRemoved)}.</li>
            )}
          </ul>
        </Download>
      )}
    </section>
  );
}
