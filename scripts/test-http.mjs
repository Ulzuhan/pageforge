// The gate and the «nowhere to upload» rule, against the real binaries (or the
// images, with TEST_LAUNCH) and the synthetic provider. No browser: plain HTTP,
// redirects followed by hand so every hop is checked.
//
//   npm run build && node scripts/test-http.mjs
import assert from 'node:assert/strict';
import { startAll } from './harness.mjs';

const { idp, apps, stop } = await startAll();
let failures = 0;
const check = async (title, fn) => {
  try { await fn(); console.log(`  ok  ${title}`); } catch (e) { failures++; console.log(`  FAIL ${title}\n       ${e.message.split('\n').join('\n       ')}`); }
};

const get = (url, cookies = '', init = {}) => fetch(url, { redirect: 'manual', ...init, headers: { ...(cookies ? { cookie: cookies } : {}), ...(init.headers || {}) } });
const setCookies = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]);
const jar = (list) => list.filter((c) => !c.endsWith('=')).join('; ');

// Sign in as `user` through the provider, hop by hop. Returns the final location and cookies.
async function signIn(app, user) {
  idp.setUser(user);
  let res = await get(`${app.origin}/auth/login?next=/app/`);
  assert.equal(res.status, 307, 'login redirects to the provider');
  const loginCookies = setCookies(res);
  const authorize = new URL(res.headers.get('location'));
  assert.equal(authorize.origin, idp.origin, 'to the provider');
  res = await get(authorize.href);
  assert.equal(res.status, 302, 'the provider sends the code back');
  const callback = new URL(res.headers.get('location'));
  assert.equal(callback.origin, app.origin);
  res = await get(callback.href, jar(loginCookies));
  return { status: res.status, location: res.headers.get('location'), cookies: setCookies(res) };
}

for (const app of Object.values(apps)) {
  console.log(`\n${app.name}  ${app.origin}`);
  const other = app.name === 'pageforge' ? 'inkbar' : 'pageforge';

  await check('health and the public landing page', async () => {
    assert.equal((await get(`${app.origin}/healthz`)).status, 200);
    const res = await get(`${app.origin}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Sign in to use/);
    assert.match(res.headers.get('content-security-policy'), /require-trusted-types-for 'script'/);
  });

  await check('search engines stay out until it is announced', async () => {
    const robots = await get(`${app.origin}/robots.txt`);
    assert.equal(robots.status, 200);
    assert.equal(await robots.text(), 'User-agent: *\nDisallow: /\n');
    for (const path of ['/', '/robots.txt', '/healthz']) {
      assert.equal((await get(`${app.origin}${path}`)).headers.get('x-robots-tag'), 'noindex, nofollow', path);
    }
  });

  await check('the tool is behind sign-in', async () => {
    const res = await get(`${app.origin}/app/`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/auth/login?next=%2Fapp%2F');
    assert.equal((await get(`${app.origin}/api/session`)).status, 401);
  });

  await check('nothing but GET/HEAD, and POST only on /auth/logout', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      for (const path of ['/', '/app/', '/upload', '/api/session', '/api/files']) {
        const res = await fetch(`${app.origin}${path}`, { method, redirect: 'manual' });
        assert.equal(res.status, 405, `${method} ${path}`);
      }
    }
  });

  await check('no route accepts a body, not even logout', async () => {
    const body = new Uint8Array(4096);
    let res = await fetch(`${app.origin}/auth/logout`, { method: 'POST', body, headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(res.status, 405);
    res = await fetch(`${app.origin}/`, { method: 'POST', body: new FormData() });
    assert.equal(res.status, 405);
  });

  await check('a member signs in: PKCE, client_secret_post, sealed session of 2 h', async () => {
    idp.log.length = 0;
    const r = await signIn(app, 'ana');
    assert.equal(r.status, 302);
    assert.equal(r.location, '/app/');
    const session = r.cookies.find((c) => c.startsWith(`${app.name}_session=`));
    assert.ok(session, 'a session cookie');
    assert.ok(!session.includes('ana@example.com') && !session.includes('.'), 'the cookie is sealed, not readable');
    const token = idp.log.find((l) => l.at === 'token');
    assert.deepEqual(token, { at: 'token', contentType: 'application/x-www-form-urlencoded', secretInBody: true, verifier: true });
    assert.equal(idp.log.find((l) => l.at === 'authorize').scope, 'openid email profile');

    const page = await get(`${app.origin}/app/`, session);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<div id="root">/);
    const me = await (await get(`${app.origin}/api/session`, session)).json();
    assert.deepEqual(me, { email: 'ana@example.com', name: '', accountUrl: 'https://account.example.com' });
  });

  await check('a session of one tool does not open the other', async () => {
    const r = await signIn(app, 'ana');
    const session = r.cookies.find((c) => c.startsWith(`${app.name}_session=`)).replace(`${app.name}_session=`, `${other}_session=`);
    assert.equal((await get(`${apps[other].origin}/api/session`, session)).status, 401);
  });

  await check('someone without the group gets in nowhere, and is told why', async () => {
    for (const user of ['beto', app.name === 'pageforge' ? 'carla' : null].filter(Boolean)) {
      const r = await signIn(app, user);
      assert.equal(r.location, '/?error=access', user);
      assert.ok(!r.cookies.some((c) => c.startsWith(`${app.name}_session=`) && !c.endsWith('=')), `${user} gets no session`);
    }
  });

  await check('a code cannot be replayed, and a forged state is refused', async () => {
    idp.setUser('ana');
    const login = await get(`${app.origin}/auth/login`);
    const cookies = jar(setCookies(login));
    const back = new URL((await get(login.headers.get('location'))).headers.get('location'));
    const forged = new URL(back); forged.searchParams.set('state', 'forged');
    assert.equal((await get(forged.href, cookies)).headers.get('location'), '/?error=signin', 'forged state');
    assert.equal((await get(back.href, cookies)).headers.get('location'), '/', 'the genuine callback works');
    assert.equal((await get(back.href, cookies)).headers.get('location'), '/?error=signin', 'the same code a second time');
  });

  await check('open redirects are closed', async () => {
    idp.setUser('ana');
    const login = await get(`${app.origin}/auth/login?next=//evil.example/`);
    const back = (await get(login.headers.get('location'))).headers.get('location');
    const res = await get(back, jar(setCookies(login)));
    assert.equal(res.headers.get('location'), '/');
  });

  await check('logout: same origin only, clears the session, points at the provider', async () => {
    const session = jar((await signIn(app, 'ana')).cookies);
    let res = await fetch(`${app.origin}/auth/logout`, { method: 'POST', headers: { cookie: session, 'sec-fetch-site': 'cross-site' } });
    assert.equal(res.status, 403);
    res = await fetch(`${app.origin}/auth/logout`, { method: 'POST', headers: { cookie: session, origin: app.origin } });
    assert.equal(res.status, 200);
    assert.match((await res.json()).next, /\/protocol\/openid-connect\/logout$/);
    assert.ok(setCookies(res).some((c) => c === `${app.name}_session=`), 'cleared');
  });

  await check('the server log never carries a token, a code or an e-mail', async () => {
    const all = app.log.join('\n');
    assert.ok(!/ana@example\.com|code=|access_token|Bearer/.test(all), all.slice(0, 500));
  });
}

await stop();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
