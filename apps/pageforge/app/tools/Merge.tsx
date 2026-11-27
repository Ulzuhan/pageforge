import { useEffect, useRef, useState } from 'react';
import { CoreError, Download, EncryptionNotice, FilePicker, PasswordPrompt, SizeNotice, inspect, plural, run, size } from '@shell';
import type { Encryption } from '@pdf-core/open';
import { JobStatus, move, useJob, useReorder } from '../parts';

type Item = {
  id: number; file: File; password?: string;
  state: 'reading' | 'ready' | 'password' | 'wrong-password' | 'failed';
  pages?: number; encryption?: Encryption;
};

let ids = 0;

export function Merge() {
  const [items, setItems] = useState<Item[]>([]);
  const { job, start, reset } = useJob<'merge'>();
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const update = (id: number, patch: Partial<Item>) => { if (alive.current) setItems((list) => list.map((it) => (it.id === id ? { ...it, ...patch } : it))); };
  async function read(it: Item, password?: string) {
    update(it.id, { state: 'reading', password });
    try {
      const info = await inspect(it.file, password);
      update(it.id, { state: 'ready', pages: info.pages, encryption: info.encryption, password });
    } catch (e) {
      const code = e instanceof CoreError ? e.code : 'failed';
      update(it.id, { state: code === 'password' || code === 'wrong-password' ? code : 'failed' });
    }
  }
  function add(files: File[]) {
    reset();
    const fresh = files.map((file): Item => ({ id: ++ids, file, state: 'reading' }));
    setItems((list) => [...list, ...fresh]);
    void (async () => { for (const it of fresh) await read(it); })();
  }
  const reorder = (from: number, to: number) => { reset(); setItems((list) => move(list, from, to)); };
  const { props, over } = useReorder(reorder);

  const ready = items.length >= 2 && items.every((it) => it.state === 'ready');
  const total = items.reduce((a, it) => a + it.file.size, 0);

  async function merge() {
    await start('Merging', async () => {
      const files = await Promise.all(items.map(async (it) => ({ bytes: await it.file.arrayBuffer(), password: it.password })));
      return run({ type: 'merge', files }, files.map((f) => f.bytes));
    });
  }

  return (
    <section className="tool">
      <FilePicker accept="application/pdf,.pdf" multiple label={items.length ? 'Add more PDFs' : 'Choose two or more PDFs, or drop them here'}
        hint="Drag them into the order you want, or use the arrows." onFiles={add} />
      {items.length > 0 && (
        <ol className="files" data-testid="merge-list">
          {items.map((it, i) => (
            <li key={it.id} className={`file-item${over === i ? ' over' : ''}`} data-testid="merge-item" {...props(i)}>
              <span className="grip" aria-hidden="true">⋮⋮</span>
              <span className="file-name">{it.file.name}</span>
              <span className="muted">
                {it.state === 'ready' ? `${plural(it.pages!, 'page')} · ${size(it.file.size)}` : it.state === 'reading' ? 'reading…' : it.state === 'failed' ? 'not a readable PDF' : 'needs its password'}
              </span>
              <span className="actions">
                <button type="button" aria-label={`Move ${it.file.name} up`} data-testid="move-up" disabled={i === 0} onClick={() => reorder(i, i - 1)}>↑</button>
                <button type="button" aria-label={`Move ${it.file.name} down`} data-testid="move-down" disabled={i === items.length - 1} onClick={() => reorder(i, i + 1)}>↓</button>
                <button type="button" aria-label={`Remove ${it.file.name}`} data-testid="remove" onClick={() => { reset(); setItems((l) => l.filter((x) => x.id !== it.id)); }}>✕</button>
              </span>
              {(it.state === 'password' || it.state === 'wrong-password') && (
                <PasswordPrompt name={it.file.name} wrong={it.state === 'wrong-password'} onSubmit={(pw) => void read(it, pw)} />
              )}
            </li>
          ))}
        </ol>
      )}
      <SizeNotice bytes={total} />
      {items.length > 0 && (
        <div className="run">
          <button type="button" className="primary" disabled={!ready || job.phase === 'working'} onClick={() => void merge()} data-testid="run">
            Merge {items.length > 1 ? plural(items.length, 'file') : ''}
          </button>
          {items.length === 1 && <span className="muted">Add at least one more PDF.</span>}
        </div>
      )}
      <JobStatus job={job} />
      {job.phase === 'done' && (
        <Download bytes={job.output.bytes} name="merged.pdf" mime={job.output.mime}>
          <ul className="report" data-testid="report">
            <li>{plural(job.output.report.pages, 'page')} from {plural(items.length, 'file')}.</li>
            {job.output.report.duplicates > 0 && <li>{plural(job.output.report.duplicates, 'identical part')} (fonts, images) stored once.</li>}
            {job.output.report.linksRemoved > 0 && <li>{plural(job.output.report.linksRemoved, 'link')} to pages or places that no longer exist removed.</li>}
            {job.output.report.actionsRemoved > 0 && <li>{plural(job.output.report.actionsRemoved, 'script or action')} that would run code removed.</li>}
            <li>Bookmarks, form logic and the files’ own metadata do not come along.</li>
          </ul>
          <EncryptionNotice encryption={job.output.report.encryption} />
        </Download>
      )}
    </section>
  );
}
