// The promises a browser can check, in a real browser, for both tools:
//  - zero CSP or Trusted Types violations, in the page AND in the workers;
//  - pdf.js runs in its own worker (never the «fake worker» on the main thread);
//  - while a PDF is open, every request goes to this origin, by GET, without a body;
//  - the gate: a member gets in, someone without the group is turned away;
//  - sign-out clears the session.
//
//   npm run build && node scripts/test-browser.mjs
//   (locally it drives the installed Chrome; in CI, Playwright's Chromium)
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startAll } from './harness.mjs';

const fixture = (f) => fileURLToPath(new URL(`../packages/pdf-core/test/fixtures/${f}`, import.meta.url));
const channel = process.env.PW_CHANNEL ?? (process.env.CI ? undefined : 'chrome');
const { idp, apps, stop } = await startAll();
const browser = await chromium.launch({ channel, headless: true });
let failures = 0;
const check = async (title, fn) => {
  try { await fn(); console.log(`  ok  ${title}`); } catch (e) { failures++; console.log(`  FAIL ${title}\n       ${String(e.message).split('\n').slice(0, 12).join('\n       ')}`); }
};

const CSP_WATCH = () => {
  const box = (globalThis.__csp = []);
  globalThis.addEventListener('securitypolicyviolation', (e) => box.push(`${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`));
};

async function session() {
  const ctx = await browser.newContext();
  await ctx.addInitScript(CSP_WATCH);
  const page = await ctx.newPage();
  const state = { phase: 'start', requests: [], console: [], workers: [] };
  const note = (where) => (m) => state.console.push(`${where} ${m.type()}: ${m.text()}`);
  page.on('console', note('page'));
  page.on('pageerror', (e) => state.console.push(`page error: ${e.message}`));
  page.on('worker', (w) => {
    state.workers.push(w);
    w.on('console', note(`worker ${new URL(w.url()).pathname}`));
    w.evaluate(CSP_WATCH).catch(() => {});
  });
  ctx.on('request', (r) => state.requests.push({ phase: state.phase, url: r.url(), method: r.method(), body: r.postDataBuffer()?.length ?? 0 }));
  return { ctx, page, state };
}

async function violations(page, state) {
  const found = [...(await page.evaluate(() => globalThis.__csp))];
  for (const w of state.workers) found.push(...((await w.evaluate(() => globalThis.__csp).catch(() => [])) ?? []));
  // Chrome also reports blocked things on the console, including some the event misses.
  found.push(...state.console.filter((l) => /Content Security Policy|Trusted Type|Refused to/i.test(l)));
  return found;
}

for (const app of Object.values(apps)) {
  console.log(`\n${app.name}  ${app.origin}`);

  await check('a member signs in, opens PDFs, and nothing leaves the origin', async () => {
    const { ctx, page, state } = await session();
    idp.setUser('ana');
    await page.goto(`${app.origin}/`);
    assert.deepEqual(await violations(page, state), [], 'landing page');
    state.phase = 'login';
    await page.getByTestId('sign-in').click();
    await page.waitForURL(`${app.origin}/app/`);
    await page.getByTestId('who').filter({ hasText: 'ana@example.com' }).waitFor();

    state.phase = 'app';
    // a plain letter: one page, every glyph read by pdf-core, a thumbnail from pdf.js
    await page.getByTestId('file').setInputFiles(fixture('libreoffice-letter.pdf'));
    await page.getByTestId('result').waitFor();
    assert.equal(await page.getByTestId('pages').textContent(), '1');
    assert.ok(parseInt(await page.getByTestId('glyphs').textContent(), 10) > 100);
    await page.locator('[data-testid=thumbs] img').first().waitFor();
    assert.ok(await page.locator('[data-testid=thumbs] img').first().evaluate((img) => img.complete && img.naturalWidth > 0), 'thumbnail drawn');

    // two pages sharing a Form XObject
    await page.getByTestId('file').setInputFiles(fixture('shared-xobject.pdf'));
    await page.getByTestId('pages').filter({ hasText: '2' }).waitFor();
    await page.locator('[data-testid=thumbs] img').nth(1).waitFor();

    // a password to open: asked for, then opened
    await page.getByTestId('file').setInputFiles(fixture('aes128-user-password.pdf'));
    await page.getByTestId('password').fill('abrir');
    await page.getByTestId('password').press('Enter');
    await page.getByTestId('encryption').filter({ hasText: 'password to open' }).waitFor();
    await page.locator('[data-testid=thumbs] img').first().waitFor();

    assert.deepEqual(await violations(page, state), [], 'CSP / Trusted Types');
    assert.ok(!state.console.some((l) => /fake worker/i.test(l)), 'pdf.js must not fall back to a fake worker');
    const workerPaths = state.workers.map((w) => new URL(w.url()).pathname);
    assert.ok(workerPaths.some((p) => /pdf\.worker/.test(p)) && workerPaths.some((p) => /\/assets\/worker-/.test(p)), `both workers: ${workerPaths}`);

    const appRequests = state.requests.filter((r) => r.phase === 'app');
    assert.ok(appRequests.length > 0);
    const offending = appRequests.filter((r) => !r.url.startsWith(`${app.origin}/`) && !r.url.startsWith('blob:') || r.method !== 'GET' || r.body > 0);
    assert.deepEqual(offending, [], 'with a PDF open: same origin, GET, no body');

    state.phase = 'logout';
    await page.getByTestId('sign-out').click();
    await page.waitForURL((u) => u.origin === idp.origin);
    const after = await ctx.request.get(`${app.origin}/api/session`);
    assert.equal(after.status(), 401, 'signed out');
    const posts = state.requests.filter((r) => r.method !== 'GET');
    assert.deepEqual(posts.map((r) => `${r.method} ${new URL(r.url).pathname} ${r.body}`), ['POST /auth/logout 0']);
    await ctx.close();
  });

  await check('someone without the group is turned away with a reason', async () => {
    const { ctx, page, state } = await session();
    idp.setUser('beto');
    await page.goto(`${app.origin}/`);
    await page.getByTestId('sign-in').click();
    await page.waitForURL(`${app.origin}/?error=access`);
    assert.match(await page.locator('#error').textContent(), /does not have access/);
    assert.equal((await ctx.request.get(`${app.origin}/api/session`)).status(), 401);
    assert.deepEqual(await violations(page, state), []);
    await ctx.close();
  });
}

await browser.close();
await stop();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
