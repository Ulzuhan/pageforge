// The promises a browser can check, in a real browser, for both tools:
//  - zero CSP or Trusted Types violations, in the page AND in the workers;
//  - pdf.js runs in its own worker (never the «fake worker» on the main thread);
//  - while a PDF is open, every request goes to this origin, by GET, without a body;
//  - the gate: a member gets in, someone without the group is turned away;
//  - sign-out clears the session;
//  - PageForge's six functions, end to end: files in through the page, the
//    download checked in Node (pages, order, rotation, what must be gone).
//
//   npm run build && node scripts/test-browser.mjs
//   (SHOTS=<dir> also saves a screenshot of each PageForge tool)
//   (locally it drives the installed Chrome; in CI, Playwright's Chromium)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { PDFDocument } from '@cantoo/pdf-lib';
import { chromium } from 'playwright';
import { startAll } from './harness.mjs';
import { MARKERS, cleanSamplePdf, everything, labelledPdf, photoPdf, photoPng, quadrantJpeg } from './fixtures.mjs';

const fixture = (f) => fileURLToPath(new URL(`../packages/pdf-core/test/fixtures/${f}`, import.meta.url));
// Generated inputs, written to a temporary folder (nothing binary in the repository).
const work = mkdtempSync(join(tmpdir(), 'pageforge-browser-'));
const made = async (name, bytes) => { const p = join(work, name); writeFileSync(p, await bytes); return p; };
const input = {
  a: await made('a.pdf', labelledPdf(['A1', 'A2'])),
  b: await made('b.pdf', labelledPdf(['B1'], { sizes: [[600, 700]] })),
  three: await made('three.pdf', labelledPdf(['P1', 'P2', 'P3'])),
  photos: await made('photos.pdf', photoPdf({ count: 2 })),
  clean: await made('clean-me.pdf', cleanSamplePdf()),
  phone: await made('phone.jpg', quadrantJpeg(400, 300, 6)),
  png: await made('wide.png', photoPng(300, 200)),
};
const pdf = (b) => PDFDocument.load(b, { updateMetadata: false });
const widths = async (b) => (await pdf(b)).getPages().map((p) => Math.round(p.getWidth()));
const shots = process.env.SHOTS;
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

  if (app.name === 'inkbar') await check('a member signs in, opens PDFs, and nothing leaves the origin', async () => {
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

  if (app.name === 'pageforge') await check('a member uses the six tools, and nothing leaves the origin', async () => {
    const { ctx, page, state } = await session();
    idp.setUser('ana');
    await page.goto(`${app.origin}/`);
    assert.deepEqual(await violations(page, state), [], 'landing page');
    state.phase = 'login';
    await page.getByTestId('sign-in').click();
    await page.waitForURL(`${app.origin}/app/`);
    await page.getByTestId('who').filter({ hasText: 'ana@example.com' }).waitFor();
    state.phase = 'app';

    // The hash changes first and React renders the tool after it: wait for the tool itself.
    const tool = async (id) => {
      await page.getByTestId(`tool-${id}`).click();
      await page.locator(`[data-testid=tool-${id}][aria-current=page]`).waitFor();
    };
    const download = async () => {
      await page.getByTestId('download').waitFor({ timeout: 60_000 });
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download').click()]);
      return { name: dl.suggestedFilename(), bytes: new Uint8Array(readFileSync(await dl.path())) };
    };
    const shot = async (id) => { if (shots) await page.screenshot({ path: join(shots, `${id}.png`), fullPage: true }); };

    // Merge: three files, one with a password, reordered with the arrows
    await tool('merge');
    await page.getByTestId('file').setInputFiles([input.b, input.a, fixture('aes128-user-password.pdf')]);
    await page.getByTestId('password').fill('abrir');
    await page.getByTestId('password').press('Enter');
    await page.getByTestId('merge-item').nth(2).filter({ hasText: '1 page' }).waitFor();
    await page.getByTestId('merge-item').nth(1).getByTestId('move-up').click();
    await page.getByTestId('run').click();
    let out = await download();
    assert.equal(out.name, 'merged.pdf');
    assert.deepEqual((await widths(out.bytes)).slice(0, 3), [500, 501, 600], 'merge order');
    assert.equal((await pdf(out.bytes)).getPageCount(), 4);
    assert.match(await page.getByTestId('result').textContent(), /no password/);
    await shot('merge');

    // Organize: delete the middle page, turn the first, move the last one first
    await tool('organize');
    await page.getByTestId('file').setInputFiles(input.three);
    await page.locator('[data-testid=page] img').nth(2).waitFor();
    await page.getByTestId('page').nth(1).getByTestId('delete').click();
    await page.getByTestId('page').nth(0).getByTestId('rotate-right').click();
    await page.getByTestId('page').nth(1).getByTestId('move-earlier').click();
    await page.getByTestId('run').click();
    out = await download();
    assert.equal(out.name, 'three-organized.pdf');
    assert.deepEqual(await widths(out.bytes), [502, 500], 'organize order');
    assert.deepEqual((await pdf(out.bytes)).getPages().map((p) => p.getRotation().angle), [0, 90], 'organize rotation');
    await shot('organize');

    // Split: a wrong range is explained; then one file per range, in a zip
    await tool('split');
    await page.getByTestId('file').setInputFiles(input.three);
    await page.getByTestId('mode-ranges').check();
    await page.getByTestId('ranges').fill('5');
    await page.getByText(/outside the document/).waitFor();
    assert.equal(await page.getByTestId('run').isDisabled(), true);
    await page.getByTestId('ranges').fill('1-2, 3');
    await page.getByTestId('run').click();
    out = await download();
    assert.equal(out.name, 'three-split.zip');
    const files = unzipSync(out.bytes);
    assert.deepEqual(Object.keys(files), ['three-pages-1-2.pdf', 'three-page-3.pdf']);
    assert.deepEqual(await widths(files['three-pages-1-2.pdf']), [500, 501]);
    await shot('split');

    // Images to PDF: a phone photo stored sideways comes out upright, without its EXIF
    await tool('images');
    await page.getByTestId('file').setInputFiles([input.phone, input.png]);
    await page.getByTestId('paper').selectOption('a4');
    await page.getByTestId('run').click();
    out = await download();
    const doc = await pdf(out.bytes);
    assert.deepEqual(doc.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]), [[595, 842], [842, 595]]);
    assert.ok(!(await everything(out.bytes)).includes(MARKERS.exif), 'EXIF gone');
    assert.match(await page.getByTestId('report').textContent(), /turned upright.*including where it was taken/s);
    await shot('images');

    // Compress: photos at medium, in pdf-core's worker with OffscreenCanvas
    await tool('compress');
    await page.getByTestId('file').setInputFiles(input.photos);
    await page.getByTestId('level-medium').check();
    await page.getByTestId('run').click();
    out = await download();
    const before = readFileSync(input.photos).length;
    assert.ok(out.bytes.length < before * 0.3, `compressed ${out.bytes.length} of ${before}`);
    assert.equal((await pdf(out.bytes)).getPageCount(), 2);
    assert.match(await page.getByTestId('report').textContent(), /2 images recompressed, 2 of them at a lower resolution/);
    await page.locator('.compare img').nth(1).waitFor();
    await shot('compress');

    // Clean: everything found is listed, and gone from the download
    await tool('clean');
    await page.getByTestId('file').setInputFiles(input.clean);
    await page.getByTestId('run').click();
    out = await download();
    const report = await page.getByTestId('report').textContent();
    for (const what of [/Camera data in 1 photo, including where it was taken/, /1 attached file/, /1 earlier version/, /XMP/, /script/, /form fields: their values stay on the page/]) {
      assert.match(report, what);
    }
    const left = await everything(out.bytes);
    for (const m of [MARKERS.exif, MARKERS.attachment, MARKERS.js, MARKERS.author, MARKERS.hidden]) assert.ok(!left.includes(m), `${m} gone`);
    // (that the form's value is still drawn is checked by the unit tests, with the interpreter: pdf-lib writes it in hex)
    assert.equal((await pdf(out.bytes)).getPageCount(), 1);
    await shot('clean');

    assert.deepEqual(await violations(page, state), [], 'CSP / Trusted Types');
    assert.ok(!state.console.some((l) => /fake worker/i.test(l)), 'pdf.js must not fall back to a fake worker');
    const workerPaths = state.workers.map((w) => new URL(w.url()).pathname);
    assert.ok(workerPaths.some((p) => /pdf\.worker/.test(p)) && workerPaths.some((p) => /\/assets\/worker-/.test(p)), `both workers: ${workerPaths}`);
    const appRequests = state.requests.filter((r) => r.phase === 'app');
    const offending = appRequests.filter((r) => !r.url.startsWith(`${app.origin}/`) && !r.url.startsWith('blob:') || r.method !== 'GET' || r.body > 0);
    assert.deepEqual(offending, [], 'with files open: same origin, GET, no body');
    assert.ok(!state.console.some((l) => /page error/.test(l)), state.console.filter((l) => /page error/.test(l)).join('\n'));

    state.phase = 'logout';
    await page.getByTestId('sign-out').click();
    await page.waitForURL((u) => u.origin === idp.origin);
    assert.equal((await ctx.request.get(`${app.origin}/api/session`)).status(), 401, 'signed out');
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
rmSync(work, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
