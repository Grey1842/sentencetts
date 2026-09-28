// E2E: loads the REAL unpacked extension (chrome-build/) in Chromium, serves
// novelbuddy-style chapter pages (history.pushState + in-place article swap —
// the exact mechanism verified in the site's shipped Next.js pages-router
// chunks), then drives the extension the way the popup does and verifies the
// full SPA detection loop WITHOUT any document refresh:
//   1. spa-main.js (manifest "world":"MAIN") installs the page-world History
//      patch — the piece that used to be an inline <script> and was silently
//      CSP-blocked in Chrome MV3 (extension CSP governs content-script-
//      injected inline scripts; verified in Chromium 153).
//   2. tabs.sendMessage('ttsr-prepare') splits chapter 382 like the popup.
//   3. Clicking Next fires pushState -> ttsr-spa-nav -> debounced check ->
//      handleContentReset, all in the SAME document (marker survives).
//   4. Re-preparing on chapter 383 splits the new content.
// Run: PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers node tests/e2e-spa-probe.js
// Needs: playwright-core at /tmp/e2e/node_modules, full chromium build (not
// headless-shell).
'use strict';
const http = require('http');
const { chromium } = require('/tmp/e2e/node_modules/playwright-core');

const BUILD = '/home/grey/Downloads/sentencetts/sentencetts-reader/chrome-build';

function chapterPage(num, nextSlug) {
  return `<!doctype html><html><head><title>Chapter ${num}</title></head><body>
<header class="site-nav">NovelBuddy Chapter ${num}: The Sovereign of Order A- A A+</header>
<article class="novel-reader-content"><header><h2>Chapter ${num}</h2></header>
<div class="novel-tts-content">
<p>Rape, sexual slavery, pointless torture, wanton destruction of survival resources, and similar acts
of cruelty did not make the zombies more dangerous in chapter number ${num} of this saga.</p>
<p>Zayne stood atop the shattered spire of the old cathedral and watched the horizon burn with the
fires of a world remade by his nine rules of order, chapter ${num} unfolding.</p>
<p>The survivors gathered at the broken gates of the enclave and waited for the sovereign to speak
his judgment upon them all in chapter ${num}.</p>
</div>
</article>
<footer><a id="next-link" href="/novel/chapter-${nextSlug}">Next chapter</a></footer>
<script src="/site.js"></` + `script>
</body></html>`;
}

async function main() {
  let failed = 0;
  function check(name, cond) {
    console.log((cond ? 'PASS ' : 'FAIL ') + name);
    if (!cond) failed += 1;
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/site.js') {
      // novelbuddy-style client-side nav: intercept the Next link, pushState,
      // swap the article in place. No document reload.
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(`document.getElementById('next-link').addEventListener('click', (e) => {
  e.preventDefault();
  const href = e.currentTarget.getAttribute('href');
  history.pushState({}, '', href);
  fetch(href).then((r) => r.text()).then((html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const next = doc.querySelector('article.novel-reader-content');
    document.querySelector('article.novel-reader-content').replaceWith(next);
    document.title = doc.title;
  });
});`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (req.url.includes('chapter-383')) res.end(chapterPage(383, '384'));
    else res.end(chapterPage(382, '383'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const ctx = await chromium.launchPersistentContext('/tmp/e2e-profile', {
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
  const cspErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /inline script|Content Security Policy/i.test(m.text())) {
      cspErrors.push(m.text().slice(0, 140));
    }
  });
  await page.goto(base + '/novel/chapter-382');
  await page.waitForTimeout(1500);
  // 1) The MAIN-world patch must be installed by the browser itself.
  const patch = await page.evaluate(() => !!window.__ttsrSpaMainPatch);
  check('page-world History patch installed from manifest (world:MAIN)', patch);

  // 2) Reach the tab like the popup does: background worker -> tabs.sendMessage.
  let bg = null;
  for (const w of ctx.serviceWorkers()) {
    if (w.url().includes('background')) bg = w;
  }
  if (!bg) {
    try { bg = await ctx.waitForEvent('serviceworker'); } catch (e) {}
  }
  if (!bg) throw new Error('background worker not found');
  const tabId = (await bg.evaluate(async (b) =>
    (await chrome.tabs.query({ url: b + '/*' })).map((t) => t.id), base))[0];
  if (!tabId) throw new Error('chapter tab not visible to the worker');

  const prepared = await bg.evaluate(async (tid) =>
    chrome.tabs.sendMessage(tid, { type: 'ttsr-prepare' })
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) })), tabId);
  console.log('ttsr-prepare:', JSON.stringify(prepared));
  check('ttsr-prepare split chapter 382', !!prepared && prepared.ok && prepared.count >= 3);

  // 3) Real user action: click Next. Marker proves no reload happened.
  await page.evaluate(() => { window.__e2eSameDocument = true; });
  await page.click('#next-link');
  // Detection is debounced (+800ms check, +2s/+4s follow-ups); poll generously.
  let detected = false;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(500);
    const st = await bg.evaluate(async (tid) =>
      chrome.tabs.sendMessage(tid, { type: 'ttsr-status' }).catch(() => null), tabId)
      .catch(() => null);
    const href = await page.evaluate(() => location.href);
    if (href.includes('chapter-383') && st && st.prepared === false && st.total === 0) {
      detected = true;
      break;
    }
  }
  const sameDocument = await page.evaluate(() => !!window.__e2eSameDocument);
  console.log('status after Next: detected-reset =', detected,
    '| same document =', sameDocument);
  check('SPA chapter change detected without refresh (reset fired)', detected);
  check('page was never reloaded (same document)', sameDocument);

  // 4) The new chapter is splittable right now (fresh content, same doc).
  const reprepared = await bg.evaluate(async (tid) =>
    chrome.tabs.sendMessage(tid, { type: 'ttsr-prepare' })
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) })), tabId);
  const firstSentence = await page.evaluate(() => {
    const s = document.querySelector('span[data-ttsr-index="0"]');
    return s ? s.textContent.slice(0, 90) : '(none)';
  });
  console.log('re-prepare on ch383:', JSON.stringify(reprepared),
    '| first sentence:', firstSentence);
  check('chapter 383 re-splits on the swapped DOM',
    !!reprepared && reprepared.ok && reprepared.count >= 3 && /383/.test(firstSentence));

  check('no inline-script CSP errors', cspErrors.length === 0);

  await ctx.close();
  server.close();
  console.log(failed ? 'E2E-FAIL(' + failed + ')' : 'E2E-PASS');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('E2E-ERROR', e && e.message); process.exit(1); });

