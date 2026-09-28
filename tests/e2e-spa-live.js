// LIVE-site e2e: same harness as e2e-spa-probe.js but against the REAL
// novelbuddy.me. Verifies on the production page (real CSP, real Next.js
// chunks, real containers) that:
//   1. spa-main.js (manifest "world":"MAIN") installs the page-world History
//      patch — nothing on the site can CSP-block a browser-loaded file.
//   2. The page-world pushState -> ttsr-spa-nav -> debounced reset pipeline
//      fires when a chapter swap happens (simulated exactly like the site's
//      own router: pushState + in-place article replaceWith, same document).
//   3. The real novelbuddy chapter content re-splits afterwards.
// Skipped by default (network + live site); run explicitly:
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers node tests/e2e-spa-live.js
'use strict';
const { chromium } = require('/tmp/e2e/node_modules/playwright-core');

const BUILD = '/home/grey/Downloads/sentencetts/sentencetts-reader/chrome-build';
const NOVEL = 'https://novelbuddy.me/mtl-forge-a-path-to-success';
// chapter-2326 is the novel's final chapter; its Previous link always exists.
const FROM = NOVEL + '/chapter-2326';
const TO = NOVEL + '/chapter-420-towards-the-future';

async function main() {
  let failed = 0;
  function check(name, cond) {
    console.log((cond ? 'PASS ' : 'FAIL ') + name);
    if (!cond) failed += 1;
  }

  const ctx = await chromium.launchPersistentContext('/tmp/e2e-profile-live', {
    headless: true,
    executablePath: '/tmp/pw-browsers/chromium-1243/chrome-linux64/chrome',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--disable-extensions-except=${BUILD}`,
      `--load-extension=${BUILD}`,
    ],
  });
  const page = await ctx.newPage();
  await page.goto(FROM, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(4000);

  // 1) MAIN-world patch installed on the production page.
  const patch = await page.evaluate(() => !!window.__ttsrSpaMainPatch);
  check('page-world History patch installed on live novelbuddy.me', patch);

  // Reach the tab like the popup does.
  let bg = null;
  for (const w of ctx.serviceWorkers()) {
    if (w.url().includes('background')) bg = w;
  }
  if (!bg) throw new Error('background worker not found');
  const tabId = (await bg.evaluate(async (b) =>
    (await chrome.tabs.query({ url: b + '/*' })).map((t) => t.id), 'https://novelbuddy.me'))[0];
  if (!tabId) throw new Error('novelbuddy tab not visible to the worker');

  const prepared = await bg.evaluate(async (tid) =>
    chrome.tabs.sendMessage(tid, { type: 'ttsr-prepare' })
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) })), tabId);
  console.log('ttsr-prepare (live ch2326):', JSON.stringify(prepared));
  check('live chapter splits', !!prepared && prepared.ok && prepared.count >= 3);

  // 2) Router-style nav: pushState + in-place article swap (same document),
  //    using the real previous chapter's HTML that the site itself serves.
  await page.evaluate(async (toUrl) => {
    window.__liveSameDocument = true;
    const html = await fetch(toUrl, { credentials: 'include' }).then((r) => r.text());
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const next = doc.querySelector('article.novel-reader-content');
    history.pushState({}, '', toUrl);
    const cur = document.querySelector('article.novel-reader-content');
    if (cur && next) cur.replaceWith(next);
  }, TO);

  let detected = false;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(500);
    const st = await bg.evaluate(async (tid) =>
      chrome.tabs.sendMessage(tid, { type: 'ttsr-status' }).catch(() => null), tabId)
      .catch(() => null);
    if (st && st.prepared === false && st.total === 0) { detected = true; break; }
  }
  const sameDocument = await page.evaluate(() => !!window.__liveSameDocument);
  check('live SPA swap detected without refresh (reset fired)', detected);
  check('live page was never reloaded (same document)', sameDocument);

  // 3) Real content of the new chapter re-splits.
  const reprepared = await bg.evaluate(async (tid) =>
    chrome.tabs.sendMessage(tid, { type: 'ttsr-prepare' })
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) })), tabId);
  console.log('re-prepare (live ch420):', JSON.stringify(reprepared));
  check('new live chapter re-splits on the swapped DOM',
    !!reprepared && reprepared.ok && reprepared.count >= 3);

  await ctx.close();
  console.log(failed ? 'LIVE-E2E-FAIL(' + failed + ')' : 'LIVE-E2E-PASS');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('LIVE-E2E-ERROR', e && e.message); process.exit(1); });
