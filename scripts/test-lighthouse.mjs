// Lighthouse on both public landing pages (plan §7 and §9): performance,
// accessibility, best practices and SEO, with Lighthouse's default mobile
// settings. The tools themselves sit behind sign-in and are not audited here.
//
//   npm run build && node scripts/test-lighthouse.mjs
//   (locally it finds the installed Chrome; in CI it uses Playwright's Chromium)
import * as chromeLauncher from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { chromium } from 'playwright';
import { startAll } from './harness.mjs';

const MIN = { performance: 0.9, accessibility: 1, 'best-practices': 1, seo: 1 };

const { apps, stop } = await startAll();
const chrome = await chromeLauncher.launch({
  chromePath: process.env.CI ? chromium.executablePath() : undefined,
  chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
});
let failures = 0;
try {
  for (const app of Object.values(apps)) {
    // A score of null is a measurement that failed (in CI, the first page of a
    // cold browser sometimes reports NO_FCP), not a bad score: measure again.
    let lhr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      ({ lhr } = await lighthouse(`${app.origin}/`, { port: chrome.port, logLevel: 'error', onlyCategories: Object.keys(MIN) }));
      if (Object.keys(MIN).every((k) => lhr.categories[k].score !== null)) break;
      console.log(`     ${app.name}: no measurement (${lhr.runtimeError?.code ?? 'no score'}), attempt ${attempt} of 3`);
    }
    const scores = Object.fromEntries(Object.keys(MIN).map((k) => [k, lhr.categories[k].score]));
    const low = Object.entries(MIN).filter(([k, min]) => (scores[k] ?? 0) < min);
    console.log(`${low.length ? 'FAIL' : 'ok  '} ${app.name}  ${Object.entries(scores).map(([k, v]) => `${k} ${Math.round(v * 100)}`).join(' · ')}`);
    for (const [k] of low) {
      for (const ref of lhr.categories[k].auditRefs) {
        const a = lhr.audits[ref.id];
        if (ref.weight > 0 && a.score !== null && a.score < 1) console.log(`       ${k}: ${a.id} (${a.score}) ${a.title}`);
      }
    }
    failures += low.length ? 1 : 0;
  }
} finally {
  await chrome.kill();
  await stop();
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
