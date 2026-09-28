// FIREFOX e2e: reproduces the reported bug against REAL Firefox and the REAL
// novelbuddy page from the report. Loads the actual 2.3.2 xpi as a temporary
// add-on in Firefox (selenium-webdriver + geckodriver), seeds a fresh session
// so the extension's own auto-resume (sessionStorage 'ttsr_session' ->
// tryAutoResume) starts reading without the popup, then clicks the page's real
// "Next chapter" link and asserts — WITHOUT any reload — that the extension
// notices the SPA swap (handleContentReset -> stopReading -> emitStatus,
// observable as a page-world 'ttsr-status-changed' event with total: 0).
//
// Run: node tests/e2e-spa-firefox.js   (needs network; ~60s)
'use strict';
const { Builder, By } = require('/tmp/e2e/node_modules/selenium-webdriver');
const firefox = require('/tmp/e2e/node_modules/selenium-webdriver/firefox');
const { until } = require('/tmp/e2e/node_modules/selenium-webdriver');

const XPI = '/tmp/stt-firefox.xpi';
const GECKO = '/tmp/e2e/bin/geckodriver';
const ORIGIN = 'https://novelbuddy.me';
const PAGE = ORIGIN +
  '/doomsday-life-simulator-system-in-a-zombie-apocalypse-world-update-era' +
  '/chapter-384-encountering-his-dorm-mates-henry-and-alan';
const NEXT_PATH = '/doomsday-life-simulator-system-in-a-zombie-apocalypse-' +
  'world-update-era/chapter-385-henry-you-owe-me-fifty-bucks';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  let failed = 0;
  function check(name, cond) {
    console.log((cond ? 'PASS ' : 'FAIL ') + name);
    if (!cond) failed += 1;
  }

  const options = new firefox.Options();
  options.setBinary('/usr/bin/firefox');
  options.addArguments('-headless');
  const driver = await new Builder()
    .forBrowser('firefox')
    .setFirefoxService(new firefox.ServiceBuilder(GECKO))
    .setFirefoxOptions(options)
    .build();
  const browserLogs = [];
  try {
    await driver.installAddon(XPI, true); // temporary add-on
    console.log('temporary add-on installed');

    await driver.get(PAGE);
    await driver.wait(until.urlContains('chapter-384'), 30000);
    await sleep(5000); // let both content scripts + hydrate settle

    // 1) spa-main.js must be live in the page world (browser-loaded, CSP-free).
    const patch = await driver.executeScript(
      () => !!window.__ttsrSpaMainPatch);
    check('page-world History patch installed on real Firefox', patch);

    // 2) Seed a fresh session like the one a real read leaves behind, reload,
    //    and let the extension's own auto-resume start reading. The reload
    //    wipes page-world state, so the event recorder is (re)installed after.
    await driver.executeScript((url) => {
      sessionStorage.setItem('ttsr_session', JSON.stringify({
        url, engine: 'system', speed: 1, pitch: 1,
        playing: true, paused: false, index: 2, ts: Date.now(),
      }));
      return true;
    }, PAGE);
    await driver.navigate().refresh();
    await sleep(6000); // tryAutoResume: +600ms delay, prepare, startReading
    await driver.executeScript(() => {
      window.__events = [];
      window.addEventListener('ttsr-status-changed', (e) => {
        window.__events.push(JSON.parse(JSON.stringify(e.detail || {})));
      });
      window.addEventListener('ttsr-spa-nav', () => {
        window.__navSeen = (window.__navSeen || 0) + 1;
      });
    });
    const baseline = await driver.executeScript(() => ({
      spans: document.querySelectorAll('span[data-ttsr-index]').length,
      href: location.href,
    }));
    console.log('baseline spans:', baseline.spans);
    check('auto-resume prepared the chapter (sentences wrapped)',
      baseline.spans >= 3);

    // 3) Real user action: click the page's real Next link. Use the article's
    //    end-of-chapter Next button (the one a reader presses after finishing
    //    the chapter) — the floating top-right pager is overlapped by the
    //    site's Google Sign-In iframe in some viewports.
    const btn = await driver.findElement(
      By.css('article a[href$="chapter-385-henry-you-owe-me-fifty-bucks"]'));
    await btn.click();
    // 4) WITHOUT reload: tripwires (spa-nav event / poller / click capture /
    //    observer) -> handleContentReset -> stopReading -> emitStatus
    //    (total: 0). Poll page state for up to 20s.
    let detected = false;
    let saw385 = false;
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      const st = await driver.executeScript(() => ({
        href: location.href,
        events: window.__events,
        nav: window.__navSeen || 0,
        sameDoc: !!window.__events, // recorder object survived => no reload
        spans: document.querySelectorAll('span[data-ttsr-index]').length,
      }));
      saw385 = st.href.includes('chapter-385');
      if (saw385 && st.sameDoc &&
          st.events.some((s) => s.total === 0 && !s.isPlaying)) {
        detected = true;
        break;
      }
    }
    const after = await driver.executeScript(() => ({
      href: location.href, nav: window.__navSeen || 0,
      events: window.__events.length,
    }));
    console.log('after Next:', JSON.stringify(after));
    check('SPA swap reached chapter 385', saw385);
    check('extension noticed the swap WITHOUT refresh (reset event)',
      detected);
    check('ttsr-spa-nav fired from the page-world patch', after.nav > 0);

    // 5) Play-after-Next safety net: fresh sentences on the new chapter.
    // 5) The user's actual complaint is that a refresh was needed before
    //    reading could continue. With detection fixed, handleContentReset's
    //    auto-recover (wasPlaying) re-splits the new chapter and restarts
    //    playback at the same index — startReading emits a fresh status event
    //    with total > 0. No reload, no manual refresh.
    let resplit = false;
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      const st = await driver.executeScript(() => ({
        events: window.__events,
        spans: document.querySelectorAll('span[data-ttsr-index]').length,
        sameDoc: !!window.__events,
      }));
      const sawZero = st.events.some((s) => s.total === 0);
      const zeroAt = st.events.findIndex((x) => x.total === 0);
      const sawFresh = zeroAt >= 0 &&
        st.events.slice(zeroAt + 1).some((s) => (s.total || 0) > 0);
      if (st.sameDoc && sawZero && sawFresh) { resplit = true; break; }
    }
    check('new chapter re-splits (fresh total > 0 after reset, no reload)',
      resplit);

    await driver.quit();
    console.log(failed ? 'FF-E2E-FAIL(' + failed + ')' : 'FF-E2E-PASS');
    process.exit(failed ? 1 : 0);
  } catch (err) {
    console.error('FF-E2E-ERROR', err && err.message);
    try { console.error('recent logs:', JSON.stringify(browserLogs.slice(-5))); } catch (e) {}
    try { await driver.quit(); } catch (e) {}
    process.exit(1);
  }
}
main();

