// What every PageForge tool repeats: one PDF in (with its password), one job
// running, one result out.
import { useCallback, useRef, useState } from 'react';
import {
  CoreError, FilePicker, Notice, PasswordPrompt, SizeNotice, Working, plural, size, usePdf,
  type Output, type Progress, type Reports,
} from '@shell';

export type Pdf = ReturnType<typeof usePdf>;

export function PdfInput({ pdf, label = 'Choose a PDF or drop it here' }: { pdf: Pdf; label?: string }) {
  const s = pdf.state;
  return (
    <>
      {s.phase === 'empty' || s.phase === 'failed'
        ? <FilePicker accept="application/pdf,.pdf" label={label} hint="It is read here, in this tab, and never uploaded." onFiles={([f]) => void pdf.open(f)} />
        : (
          <div className="chosen">
            <strong>{s.file.name}</strong>
            <span className="muted">{s.phase === 'ready' ? `${plural(s.pages, 'page')} · ` : ''}{size(s.file.size)}</span>
            <button type="button" className="link" onClick={pdf.reset} data-testid="change">Choose another</button>
          </div>
        )}
      {s.phase === 'reading' && <Working what={`Reading ${s.file.name}`} />}
      {s.phase === 'password' && <PasswordPrompt name={s.file.name} wrong={s.wrong} onSubmit={(pw) => void pdf.open(s.file, pw)} />}
      {s.phase === 'failed' && <Notice tone="error">{s.message}</Notice>}
      {s.phase !== 'empty' && <SizeNotice bytes={s.file.size} />}
    </>
  );
}

type Job<K extends keyof Reports> =
  | { phase: 'idle' }
  | { phase: 'working'; what: string; progress: Progress | null }
  | { phase: 'done'; output: Output<K> }
  | { phase: 'failed'; message: string };

export function explain(e: unknown): string {
  if (e instanceof CoreError) {
    if (e.code === 'ranges') return e.message;
    if (e.code === 'unsupported-image') return `File ${(e.file ?? 0) + 1} is not a JPEG or PNG image.`;
    if (e.code === 'password' || e.code === 'wrong-password') return `File ${(e.file ?? 0) + 1} needs its password.`;
    if (e.code === 'unreadable') return `File ${(e.file ?? 0) + 1} could not be read as a PDF.`;
    return `That did not work: ${e.message}`;
  }
  return `That did not work: ${String((e as Error)?.message ?? e)}`;
}

/** One job at a time; starting another or changing the input forgets the last result. */
export function useJob<K extends keyof Reports>() {
  const [job, setJob] = useState<Job<K>>({ phase: 'idle' });
  const turn = useRef(0);
  const start = useCallback(async (what: string, fn: (progress: (p: Progress) => void) => Promise<Output<K>>) => {
    const mine = ++turn.current;
    setJob({ phase: 'working', what, progress: null });
    try {
      const output = await fn((p) => { if (mine === turn.current) setJob({ phase: 'working', what, progress: p }); });
      if (mine === turn.current) setJob({ phase: 'done', output });
    } catch (e) {
      if (mine === turn.current) setJob({ phase: 'failed', message: explain(e) });
    }
  }, []);
  const reset = useCallback(() => { turn.current++; setJob({ phase: 'idle' }); }, []);
  return { job, start, reset };
}

export function JobStatus({ job }: { job: Job<keyof Reports> }) {
  if (job.phase === 'working') return <Working what={job.what} progress={job.progress} />;
  if (job.phase === 'failed') return <Notice tone="error">{job.message}</Notice>;
  return null;
}

/** Moves item `from` to position `to` (both indices into the same list). */
export function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

/** Drag-and-drop reordering for a list; buttons do the same for keyboards and tests. */
export function useReorder(onMove: (from: number, to: number) => void) {
  const dragging = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const props = (i: number) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => { dragging.current = i; e.dataTransfer.effectAllowed = 'move'; },
    onDragOver: (e: React.DragEvent) => { if (dragging.current !== null) { e.preventDefault(); setOver(i); } },
    onDragLeave: () => setOver((o) => (o === i ? null : o)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      if (dragging.current !== null) onMove(dragging.current, i);
      dragging.current = null;
      setOver(null);
    },
    onDragEnd: () => { dragging.current = null; setOver(null); },
  });
  return { props, over };
}

/** «, including where it was taken»: how many photos carried their location. */
export const where = (gps: number, photos: number) => (!gps ? '' : gps === photos
  ? `, including where ${photos === 1 ? 'it was' : 'they were'} taken` : `, and where ${gps} of them ${gps === 1 ? 'was' : 'were'} taken`);
