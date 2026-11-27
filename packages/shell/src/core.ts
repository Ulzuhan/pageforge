// The page's side of pdf-core's worker: one request, one answer, progress in
// between. Bytes are transferred, not copied, so whoever calls reads the File
// again for each request instead of keeping a buffer around.
import type { CoreRequest, CoreResponse, ErrorCode, Inspection, Output, Reports } from '@pdf-core/worker';
import { newCoreWorker } from './workers';

export type { ErrorCode, Inspection, Output, Reports };
export type Progress = { stage: string; done: number; total: number };

export class CoreError extends Error {
  constructor(readonly code: ErrorCode, readonly file: number | undefined, message: string) { super(message); }
}

type Pending = { resolve: (r: CoreResponse) => void; progress?: (p: Progress) => void };
let core: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function worker(): Worker {
  if (core) return core;
  core = newCoreWorker();
  core.onmessage = (ev: MessageEvent<CoreResponse>) => {
    const r = ev.data, p = pending.get(r.id);
    if (!p) return;
    if (r.kind === 'progress') { p.progress?.({ stage: r.stage, done: r.done, total: r.total }); return; }
    pending.delete(r.id);
    p.resolve(r);
  };
  core.onerror = (e) => {
    // A worker that dies (out of memory, usually) answers nobody: fail them all.
    for (const [id, p] of pending) p.resolve({ id, kind: 'error', ok: false, error: 'failed', message: e.message || 'the worker stopped' });
    pending.clear();
    core?.terminate();
    core = null;
  };
  return core;
}

type Body<T> = T extends unknown ? Omit<T, 'id'> : never;

function send(req: Body<CoreRequest>, transfer: ArrayBuffer[], progress?: (p: Progress) => void): Promise<CoreResponse> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, { resolve, progress });
    worker().postMessage({ ...req, id }, transfer);
  });
}

const fail = (r: CoreResponse): never => {
  if (r.kind === 'error') throw new CoreError(r.error, r.file, r.message);
  throw new CoreError('failed', undefined, 'unexpected answer from the worker');
};

export async function inspect(file: Blob, password?: string, detail = false): Promise<Inspection> {
  const bytes = await file.arrayBuffer();
  const r = await send({ type: 'inspect', file: { bytes, password }, detail }, [bytes]);
  return r.kind === 'inspect' ? r.result : fail(r);
}

type OutputRequest = Exclude<Body<CoreRequest>, { type: 'inspect' }>;

/** Runs one of the tools. `transfer` lists the buffers inside `req` (they leave this page's memory). */
export async function run<K extends OutputRequest['type']>(req: Extract<OutputRequest, { type: K }>, transfer: ArrayBuffer[],
  progress?: (p: Progress) => void): Promise<Output<K>> {
  const r = await send(req, transfer, progress);
  return r.kind === 'output' ? (r.result as Output<K>) : fail(r);
}
