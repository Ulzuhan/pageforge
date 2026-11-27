// Pieces both tools use: choosing files, asking for a password, showing
// progress and handing over the result. No inline styles anywhere: the CSP is
// style-src 'self'.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Encryption } from '@pdf-core/open';
import type { Progress } from './core';

export const LARGE = 200 * 1024 * 1024; // past this, a warning (spike P7: memory is about twice the file)
export const TOO_LARGE = 1024 * 1024 * 1024;

export function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} kB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const baseName = (name: string) => name.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'document';

export function FilePicker({ accept, multiple = false, label, hint, onFiles }: {
  accept: string; multiple?: boolean; label: string; hint?: string; onFiles: (files: File[]) => void;
}) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const types = accept.split(',').map((s) => s.trim());
  const fits = (f: File) => types.some((t) => (t.startsWith('.') ? f.name.toLowerCase().endsWith(t) : f.type === t));
  return (
    <label className={`drop${over ? ' over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = [...e.dataTransfer.files].filter(fits);
        if (files.length) onFiles(multiple ? files : files.slice(0, 1));
      }}>
      <input ref={input} type="file" accept={accept} multiple={multiple} data-testid="file"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length) onFiles(files);
          if (input.current) input.current.value = ''; // the same file can be chosen again
        }} />
      <span className="drop-label">{label}</span>
      {hint && <span className="drop-hint">{hint}</span>}
    </label>
  );
}

export function PasswordPrompt({ name, wrong, onSubmit }: { name: string; wrong: boolean; onSubmit: (password: string) => void }) {
  return (
    <form className="password" onSubmit={(e) => {
      e.preventDefault();
      const pw = new FormData(e.currentTarget).get('password');
      if (typeof pw === 'string') onSubmit(pw);
    }}>
      <span>{wrong ? `That password did not open ${name}. Try again:` : `${name} needs a password to open.`}</span>
      <input name="password" type="password" autoComplete="off" data-testid="password" aria-label={`Password for ${name}`} />
      <button type="submit">Open</button>
    </form>
  );
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'error' }) {
  return <p className={`notice ${tone}`} role={tone === 'error' ? 'alert' : undefined}>{children}</p>;
}

/** What the inputs' encryption means for the result, said once. */
export function EncryptionNotice({ encryption }: { encryption: Encryption[] }) {
  if (encryption.includes('user-password')) {
    return <Notice tone="warn">The result has no password: anyone who gets the file can open it.</Notice>;
  }
  if (encryption.includes('owner-password-only')) {
    return <Notice tone="warn">The author of this file set restrictions on changing it. The result comes out without them.</Notice>;
  }
  return null;
}

export function SizeNotice({ bytes }: { bytes: number }) {
  if (bytes >= TOO_LARGE) return <Notice tone="error">That is more than {size(TOO_LARGE)}: too much to work on in a browser tab.</Notice>;
  if (bytes >= LARGE) return <Notice tone="warn">Large files take a while and use a lot of this device’s memory.</Notice>;
  return null;
}

const STAGES: Record<string, string> = { reading: 'Reading the pages', images: 'Recompressing images', streams: 'Compressing the rest', saving: 'Saving' };

export function Working({ what, progress }: { what: string; progress?: Progress | null }) {
  const detail = progress && progress.total > 1 ? ` · ${STAGES[progress.stage] ?? progress.stage} ${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : '';
  return <p className="status" role="status" aria-live="polite" data-testid="status">{what}…{detail}</p>;
}

/** The result, as a download. The blob URL lives as long as the component. */
export function Download({ bytes, name, mime, children }: { bytes: ArrayBuffer; name: string; mime: string; children?: ReactNode }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([bytes], { type: mime })), [bytes, mime]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div className="result" data-testid="result">
      <a className="button" href={url} download={name} data-testid="download">Download {name}</a>
      <span className="size">{size(bytes.byteLength)}</span>
      {children}
    </div>
  );
}
