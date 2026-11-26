// Starts the fake provider and both binaries (or images, with TEST_LAUNCH) for
// the suites, wired to each other.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { startFakeIdp } from './fake-idp.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export const TOOLS = [
  { name: 'pageforge', prefix: 'PAGEFORGE', group: 'pageforge' },
  { name: 'inkbar', prefix: 'INKBAR', group: 'inkbar' },
];

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function waitFor(url, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`no answer from ${url}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function startAll() {
  const ports = Object.fromEntries(await Promise.all(TOOLS.map(async (t) => [t.name, await freePort()])));
  const clients = Object.fromEntries(TOOLS.map((t) => [`${t.name}-client`, {
    secret: `${t.name}-secret-for-tests`, redirect: `http://127.0.0.1:${ports[t.name]}/auth/callback`,
  }]));
  const idp = await startFakeIdp({ clients });
  const procs = [];
  const apps = {};
  for (const t of TOOLS) {
    const env = {
      ...process.env, HOSTNAME: '127.0.0.1', PORT: String(ports[t.name]),
      [`${t.prefix}_OIDC_ISSUER`]: idp.issuer,
      [`${t.prefix}_OIDC_CLIENT_ID`]: `${t.name}-client`,
      [`${t.prefix}_OIDC_CLIENT_SECRET`]: `${t.name}-secret-for-tests`,
      [`${t.prefix}_OIDC_REDIRECT_URI`]: `http://127.0.0.1:${ports[t.name]}/auth/callback`,
      [`${t.prefix}_OIDC_REQUIRED_GROUP`]: t.group,
      [`${t.prefix}_SESSION_SECRET`]: `${t.name}-session-secret-that-is-long-enough!`,
      [`${t.prefix}_ACCOUNT_URL`]: 'https://account.example.com',
      [`${t.prefix}_INSECURE_COOKIES`]: '1',
    };
    // TEST_LAUNCH runs the published image instead (CI): it gets the same env.
    const cmd = process.env.TEST_LAUNCH ? ['bash', [`${root}scripts/launch-image.sh`, t.name, String(ports[t.name])]] : [`${root}bin/${t.name}`, []];
    const proc = spawn(cmd[0], cmd[1], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    const log = [];
    proc.stderr.on('data', (d) => log.push(...String(d).trim().split('\n')));
    procs.push(proc);
    apps[t.name] = { ...t, origin: `http://127.0.0.1:${ports[t.name]}`, log };
  }
  await Promise.all(Object.values(apps).map((a) => waitFor(`${a.origin}/healthz`)));
  const stop = async () => { for (const p of procs) p.kill('SIGTERM'); await idp.close(); };
  process.on('exit', () => procs.forEach((p) => p.kill('SIGKILL')));
  return { idp, apps, stop };
}
