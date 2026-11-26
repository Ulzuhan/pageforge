import { useEffect, useState, type ReactNode } from 'react';

type Me = { email: string; name: string; accountUrl: string };

/** The frame of either tool: who is signed in, the account link, sign out. */
export function Shell({ title, tagline, children }: { title: string; tagline: string; children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((m: Me | null) => {
        if (!m) location.assign('/auth/login?next=/app/');
        else setMe(m);
      })
      .catch(() => setMe(null));
  }, []);

  async function signOut() {
    const r = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    const { next } = r.ok ? ((await r.json()) as { next: string }) : { next: '/' };
    location.assign(next || '/');
  }

  return (
    <div className="shell">
      <header className="bar">
        <a className="brand" href="/">{title}</a>
        <span className="tagline">{tagline}</span>
        <span className="spacer" />
        {me && <span className="who" data-testid="who">{me.name || me.email}</span>}
        {me?.accountUrl && <a className="link" href={me.accountUrl}>Account</a>}
        <button type="button" className="link" onClick={signOut} data-testid="sign-out">Sign out</button>
      </header>
      <main className="main">{children}</main>
      <footer className="foot">Your files are read in this browser tab and never sent to the server.</footer>
    </div>
  );
}
