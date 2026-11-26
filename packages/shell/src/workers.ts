// The two workers, created by us and handed over. Under Trusted Types
// (`require-trusted-types-for 'script'`) a Worker URL must be a
// TrustedScriptURL; the single policy, `workers`, lets through exactly these two
// URLs and nothing else. If pdf.js created its worker by itself, Trusted Types
// would block it and pdf.js would silently fall back to parsing on the main
// thread («fake worker»): the browser suite fails on that message.
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import coreWorkerUrl from '@pdf-core/worker.ts?worker&url';

const allowed = new Set([new URL(pdfjsWorkerUrl, location.href).href, new URL(coreWorkerUrl, location.href).href]);

type Policy = { createScriptURL: (u: string) => unknown };
const policy: Policy | undefined = (globalThis as { trustedTypes?: { createPolicy: (n: string, r: object) => Policy } })
  .trustedTypes?.createPolicy('workers', {
    createScriptURL: (u: string) => {
      if (!allowed.has(new URL(u, location.href).href)) throw new TypeError(`worker URL not allowed: ${u}`);
      return u;
    },
  });

function spawn(url: string): Worker {
  const href = new URL(url, location.href).href;
  return new Worker((policy ? policy.createScriptURL(href) : href) as string, { type: 'module' });
}

export const newPdfjsWorker = () => spawn(pdfjsWorkerUrl);
export const newCoreWorker = () => spawn(coreWorkerUrl);
