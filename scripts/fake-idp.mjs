// A synthetic OIDC provider for the suites. It does the real protocol (PKCE
// S256, client_secret_post, one-time codes, exact redirect URIs) so the gate is
// tested against something that refuses what a real provider refuses.
//
// Two things on purpose:
//  - Keycloak-shaped paths, whatever provider is used in production: the tools must obey
//    the discovery document, never a URL shape written by hand.
//  - UserInfo answers with sub and email only; the groups travel in the access
//    token, as some providers do with a claims hook. That is the path the tools
//    must handle.
//
//   import { startFakeIdp } from './fake-idp.mjs'   or   node scripts/fake-idp.mjs [port]
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

export const USERS = {
  ana: { sub: 'f2a1c0de-0000-4000-8000-00000000a0a0', email: 'ana@example.com', groups: ['pageforge', 'inkbar'] },
  beto: { sub: 'f2a1c0de-0000-4000-8000-00000000b0b0', email: 'beto@example.com', groups: [] },
  carla: { sub: 'f2a1c0de-0000-4000-8000-00000000c0c0', email: 'carla@example.com', groups: ['inkbar'] },
};

const b64url = (b) => Buffer.from(b).toString('base64url');

export function startFakeIdp({ port = 0, clients = {} } = {}) {
  let current = 'ana';
  const codes = new Map();   // code → { client, redirect, challenge, user }
  const tokens = new Map();  // access token → user
  const log = [];

  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const issuer = `${origin}/realms/kaitest`;
    const url = new URL(req.url, origin);
    const p = url.pathname;
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const oidc = `${issuer}/protocol/openid-connect`;

    if (p === '/realms/kaitest/.well-known/openid-configuration') {
      return json(200, { issuer, authorization_endpoint: `${oidc}/auth`, token_endpoint: `${oidc}/token`,
        userinfo_endpoint: `${oidc}/userinfo`, end_session_endpoint: `${oidc}/logout`, jwks_uri: `${oidc}/certs`,
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'] });
    }
    if (p === '/__test/user') { current = url.searchParams.get('name'); return json(200, { user: current }); }

    if (p === '/realms/kaitest/protocol/openid-connect/auth') {
      const q = url.searchParams;
      const client = clients[q.get('client_id')];
      log.push({ at: 'authorize', client: q.get('client_id'), scope: q.get('scope') });
      if (!client || q.get('redirect_uri') !== client.redirect) return json(400, { error: 'invalid_client or redirect_uri' });
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state')) {
        return json(400, { error: 'invalid_request: PKCE S256 and state are required' });
      }
      const code = b64url(randomBytes(24));
      codes.set(code, { client: q.get('client_id'), redirect: client.redirect, challenge: q.get('code_challenge'), user: current });
      const back = new URL(client.redirect);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state'));
      res.writeHead(302, { Location: back.href });
      return res.end();
    }

    if (p === '/realms/kaitest/protocol/openid-connect/token' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const f = new URLSearchParams(body);
      const entry = codes.get(f.get('code'));
      codes.delete(f.get('code')); // one use, always
      log.push({ at: 'token', contentType: req.headers['content-type'], secretInBody: f.has('client_secret'), verifier: f.has('code_verifier') });
      const client = clients[f.get('client_id')];
      if (!client || f.get('client_secret') !== client.secret) return json(401, { error: 'invalid_client' });
      if (!entry || entry.client !== f.get('client_id') || entry.redirect !== f.get('redirect_uri')) return json(400, { error: 'invalid_grant' });
      if (b64url(createHash('sha256').update(f.get('code_verifier') || '').digest()) !== entry.challenge) return json(400, { error: 'invalid_grant: PKCE' });
      const u = USERS[entry.user];
      const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
      const payload = b64url(JSON.stringify({ sub: u.sub, email: u.email, groups: u.groups, exp: Math.floor(Date.now() / 1000) + 3600 }));
      const token = `${header}.${payload}.${b64url(randomBytes(16))}`;
      tokens.set(token, u);
      return json(200, { access_token: token, token_type: 'bearer', expires_in: 3600 });
    }

    if (p === '/realms/kaitest/protocol/openid-connect/userinfo') {
      const u = tokens.get((req.headers.authorization || '').replace(/^Bearer /, ''));
      if (!u) return json(401, { error: 'invalid_token' });
      return json(200, { sub: u.sub, email: u.email });
    }

    if (p === '/realms/kaitest/protocol/openid-connect/logout') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<!doctype html><title>signed out</title><p>Signed out of the test provider.</p>');
    }
    json(404, { error: 'not found' });
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    resolve({
      origin, issuer: `${origin}/realms/kaitest`, log,
      setUser: (name) => { current = name; },
      close: () => new Promise((r) => server.close(r)),
    });
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const idp = await startFakeIdp({ port: Number(process.argv[2] || 9999) });
  console.log(`fake provider at ${idp.issuer}`);
}
