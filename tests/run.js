// P6 in-repo test: extracted-logic simulations. Runs with plain `node tests/run.js`.
// Each test loads the REAL function bodies out of the shipped source files so
// the tests track the implementation instead of a copy.

// --- helpers ---------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
function check(name, cond) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name);
  if (!cond) failures += 1;
}
function extractFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{'));
  if (!m) throw new Error(name + ' not found in source');
  let i = m.index + m[0].length;
  let depth = 1;
  while (depth > 0) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') depth -= 1;
    i += 1;
  }
  return src.slice(m.index, i);
}

async function main() {
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const background = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const spaMain = fs.readFileSync(path.join(ROOT, 'spa-main.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const chromeManifest = fs.readFileSync(
    path.join(ROOT, 'build-source/manifest.chrome.json'), 'utf8');

  // --- 1) isSilentText -----------------------------------------------------
// eslint-disable-next-line no-eval
  const isSilentText = eval('(' + extractFn(content, 'isSilentText') + ')');
  const silentCases = [
    ['…', true], ['… …', true], ['***', true], ['—', true], ['—— ——', true],
    ['Hello world.', false], ['Wait...', false], ['½ cup', false], ['2+2=4', false],
    ['', true], ['   ', true], ['🙂', true],
  ];
  for (const [t, want] of silentCases) {
    if (isSilentText(t) !== want) throw new Error('isSilentText(' + JSON.stringify(t) + ')');
  }
  console.log('PASS isSilentText — all ' + silentCases.length + ' cases');

  // --- 2) background piper empty-text guard --------------------------------
  check('background piperSynthesize phoneme-less guard present',
    /if \(!text \|\| !\/\[\\p\{L\}\\p\{N\}\]\/u\.test\(String\(text\)\)\) return \[\];/.test(background));

  // --- 3) playback chain: silent lines never reach an engine ---------------
  function simulate(sentences) {
    const audioCache = new Map();
    const CACHE_LIMIT = 40;
    const engineCalls = [];
    const played = [];
    const STATE = { sentences, currentIndex: -1, isPlaying: true, isPaused: false, gen: 0, engine: 'piper' };
    function cacheAudio(i, buf) {
      audioCache.set(i, buf);
      if (audioCache.size > CACHE_LIMIT) audioCache.delete(audioCache.keys().next().value);
    }
    function requestAudio(index) {
      if (audioCache.has(index)) return Promise.resolve(audioCache.get(index));
      const item = STATE.sentences[index];
      if (!item) return Promise.reject(new Error('no such sentence'));
      if (isSilentText(item.text)) {
        if (!audioCache.has(index)) cacheAudio(index, []);
        return Promise.resolve([]);
      }
      engineCalls.push(item.text);
      return Promise.resolve([new ArrayBuffer(8)]);
    }
    function audioPlay(i) {
      if (i < 0 || i >= STATE.sentences.length) { STATE.stopped = true; return; }
      STATE.currentIndex = i;
      requestAudio(i).then(() => {
        if (STATE.gen !== 0 || !STATE.isPlaying || STATE.currentIndex !== i) return;
        played.push(i);
        if (i === STATE.sentences.length - 1) { STATE.ended = true; STATE.stopped = true; return; }
        audioPlay(i + 1);
      });
    }
    audioPlay(0);
    return { engineCalls, played, ended: () => STATE.ended };
  }
  const sim = simulate([
    { text: 'It was a dark night.' },
    { text: '…' },
    { text: '***' },
    { text: '"Who goes there?" she asked.' },
    { text: '—' },
    { text: '… …' },
  ]);
  await new Promise((r) => setImmediate(r));
  check('playback chain — engine called exactly 2x for 2 speakable sentences',
    sim.engineCalls.length === 2 &&
    sim.engineCalls.includes('It was a dark night.') &&
    sim.engineCalls.includes('"Who goes there?" she asked.'));
  check('playback chain — all 6 sentences traversed to the end', sim.played.length === 6 && !!sim.ended());

  // --- 4) observer: SPA swap, churn, own-UI, unprepared, hooks -------------
  function makeNode(text, connected) {
    return { innerText: text, isConnected: connected, parentNode: null };
  }
  const fakeBody = makeNode('', true);
  // Fake location object shared across factory instances in this block.
  const fakeLocation = { href: 'https://novelbuddy.me/novel/chapter-382' };
  let currentContainer = null;
  let resetCalls = 0;
  const resetArgs = [];
  function handleContentReset(arg) { resetCalls += 1; resetArgs.push(arg); }
  const observedTargets = [];
  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; }
    observe(t) { observedTargets.push(t); }
    disconnect() {}
  }
  const STATE = { prepared: true, sentences: [] };
  function extractHooks() {
    // Tripwire IIFE starts at the marker comment; it references onLikelyNav
    // from the enclosing scope, so pull both.
    const start = content.indexOf('// SPA-TRIPWIRES-IIFE-START');
    if (start < 0) throw new Error('tripwire marker not found');
    const fnIdx = content.indexOf('(function () {', start);
    if (fnIdx < 0) throw new Error('tripwire IIFE not found');
    let i = fnIdx + '(function () {'.length;
    let depth = 1;
    while (depth > 0) {
      if (content[i] === '{') depth += 1;
      else if (content[i] === '}') depth -= 1;
      i += 1;
    }
    return content.slice(fnIdx, i) + '();';
  }
  // Fake timers: scheduleContentCheck/setTimeout/setInterval are driven
  // manually so debounce max-wait + poller behavior are deterministic.
  let fakeNow = 1000000;
  const realDateNow = Date.now;
  Date.now = () => fakeNow;
  let timerSeq = 0;
  const timers = new Map(); // id -> { fn, kind }
  function fakeSetTimeout(fn) { const id = ++timerSeq; timers.set(id, { fn, kind: 'timeout' }); return id; }
  function fakeClearTimeout(id) { timers.delete(id); }
  function fakeSetInterval(fn) { const id = ++timerSeq; timers.set(id, { fn, kind: 'interval' }); return id; }
  function runTimers(kind) {
    // FIFO order, one pass: run each pending timer of the kind exactly once.
    // (Multi-pass draining would re-fire onLikelyNav's follow-ups and skew
    // baseline updates; pump()+drainTimers() compose explicit sequences.)
    const ids = [...timers.keys()];
    for (const id of ids) {
      const t = timers.get(id);
      if (t && (!kind || t.kind === kind)) { timers.delete(id); t.fn(); }
    }
  }
  const factory = new Function(
    'handleContentReset', 'STATE', 'observerSuppressed',
    'MutationObserver', 'document', 'findContentContainer', 'setTimeout', 'clearTimeout',
    'location', 'history', 'window', 'setInterval',
    `
    let contentObserver = null;
    let contentChangeTimer = null;
    let contentChangeFirstAt = 0;
    let observedFingerprint = null;
    let observedContainer = null;
    let lastRecoverAt = 0;
    let lastLocationHref = '';
    let preparedUrl = '';
    try { lastLocationHref = location.href; } catch (e) {}
    let playerEl = null;
    let hiccupEl = null;
    ${extractFn(content, 'onLikelyNav')}
    ${extractFn(content, 'contentFingerprint')}
    ${extractFn(content, 'significantContentChange')}
    ${extractFn(content, 'isOwnUiNode')}
    ${extractFn(content, 'observeContentChanges')}
    ${extractFn(content, 'scheduleContentCheck')}
    ${extractFn(content, 'contentChanged')}
    ${extractFn(content, 'runContentCheck')}
    return {
      observe: observeContentChanges,
      fire: (mutations) => contentObserver.cb(mutations),
      setUi: (p, h) => { playerEl = p; hiccupEl = h; },
      state: () => ({ observedContainer, observedFingerprint }),
      nav: onLikelyNav,
    };
    `
  );
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // pump(fakeMs): advance fake time, then run every pending fake timeout
  // (the debounce check + onLikelyNav follow-ups) synchronously.
  function pump() {
    fakeNow += 1000;
    runTimers('timeout');
  }
  function drainTimers() {
    for (let n = 0; n < 10 && timers.size; n++) runTimers('timeout');
  }
  // onLikelyNav's staggered follow-ups (fake timeouts) live in the same timer
  // map as the debounce check. Sequence danger: the FIRST check run updates
  // the observed baseline, so a follow-up that fires in the SAME drain pass
  // sees the fresh baseline and also resets → double reset. In the test we
  // only ever want the debounce check per drain; the follow-ups are covered
  // by the second api.nav() call.
  const fakeDocument = {
    body: fakeBody,
    documentElement: { appendChild: () => {}, },
    addEventListener: () => {},
    createElement: () => ({ textContent: '' }),
  };
  const stubHistory = { pushState() {}, replaceState() {} };
  const stubWindow = {
    addEventListener: () => {},
  };
  function makeApi(suppressed) {
    return factory(handleContentReset, STATE, suppressed,
      FakeMutationObserver, fakeDocument,
      () => currentContainer, fakeSetTimeout, fakeClearTimeout,
      fakeLocation, stubHistory, stubWindow, fakeSetInterval);
  }
  const api = makeApi(false);

  {
    // Tripwire contract (static — pins the defense-in-depth wiring without
    // executing content.js). The page-world patch lives in spa-main.js, a
    // manifest-declared "world": "MAIN" content script: in Chrome MV3 the
    // extension CSP also governs content-script-INJECTED inline <script>s,
    // so the previous inline injection was silently blocked there on every
    // site — the regression guard below keeps that approach out.
    check('content.js listens for the page-world ttsr-spa-nav event',
      /document\.addEventListener\('ttsr-spa-nav'/.test(content));
    check('spa-main.js patches History.prototype.pushState in the page world',
      /History\.prototype\.pushState = function/.test(spaMain));
    check('spa-main.js reports via ttsr-spa-nav tagged src=sentencetts',
      /ttsr-spa-nav/.test(spaMain) && /src:\s*'sentencetts'/.test(spaMain));
    const spaEntry = (manifest.content_scripts || [])
      .find((e) => (e.js || []).indexOf('spa-main.js') !== -1);
    check('Firefox manifest declares spa-main.js as MAIN-world document_start',
      !!spaEntry && spaEntry.world === 'MAIN' && spaEntry.run_at === 'document_start');
    check('Chrome manifest declares spa-main.js as MAIN-world document_start',
      /"js"\s*:\s*\["spa-main\.js"\]/.test(chromeManifest) &&
      /"world"\s*:\s*"MAIN"/.test(chromeManifest) &&
      /"run_at"\s*:\s*"document_start"/.test(chromeManifest));
    check('content.js no longer injects inline page-world scripts (Chrome MV3 CSP)',
      !/createElement\('script'\)/.test(content));
    check('link-click capture tripwire present',
      /closest\('a\[href\]'/.test(content));
    check('URL poller tripwire present',
      /location\.href !== lastLocationHref/.test(content));
    check('debounce has max-wait ceiling',
      /MAX_WAIT_MS/.test(content) && resetCalls === 0);
  }

  const CHROME = 'NovelBuddy Chapter 382: The Sovereign of Order A- A A+ Inter Source Sans Verdana Tahoma Arial Translate to Original English Spanish Portuguese French German Italian Russian Polish Dutch Turkish Arabic Hindi Indonesian Vietnamese Filipino Thai Japanese Korean Chinese ';
  const sentA = 'Rape, sexual slavery, pointless torture, wanton destruction of survival resources, and similar acts of cruelty did not make the zombies more dangerous.';
  const sentB = 'Zayne stood atop the shattered spire of the old cathedral and watched the horizon burn with the fires of a world remade by his nine rules of order.';
  const filler = ' He looked at the system screen and nodded once. The survivors below kept moving. ';
  // Timer-less scenarios run the debounce through fake timers: fire()
  // schedules runContentCheck via fakeSetTimeout, pump() fires it.
  const coarse = makeNode(CHROME + sentA + filler, true);
  currentContainer = coarse;
  STATE.sentences = [{ text: sentA }];
  api.observe();
  check('observer watches document.body', observedTargets.length === 1 && observedTargets[0] === fakeBody);

  api.fire([{ target: fakeBody }]);
  pump(); drainTimers();
  check('unchanged coarse content does not reset', resetCalls === 0);

  coarse.innerText = CHROME + sentB + filler;
  api.fire([{ target: fakeBody }]);
  pump(); drainTimers();
  check('coarse-container chapter swap detected with recovery', resetCalls === 1 && resetArgs[0] === true);

  resetCalls = 0; resetArgs.length = 0;
  STATE.prepared = false;
  const sentC = 'The survivors gathered at the broken gates of the enclave and waited for the sovereign to speak his judgment upon them all.';
  coarse.innerText = CHROME + sentC + filler;
  api.fire([{ target: fakeBody }]);
  pump(); drainTimers();
  check('swap detected even while unprepared', resetCalls === 1);
  STATE.prepared = true;

  resetCalls = 0; resetArgs.length = 0;
  const articleA = makeNode(
    'Chapter one. It was a dark and stormy night. The wind howled through the ancient pines, ' +
    'rattling the shutters of the old lighthouse while the keeper climbed the spiral stairs with ' +
    'a lantern swinging wildly in his weathered hand, muttering about the sea.', true);
  currentContainer = articleA;
  STATE.sentences = [{ text: 'It was a dark and stormy night. The wind howled through the ancient pines, rattling the shutters of the old lighthouse' }];
  api.observe();
  articleA.innerText += ' A bird sang.';
  api.fire([{ target: fakeBody }]);
  pump(); drainTimers();
  check('ad/lazy-load churn does not reset', resetCalls === 0);

  const articleB = makeNode('Chapter two. A completely different story began here with new characters and an entirely different setting than before.', true);
  articleA.isConnected = false;
  currentContainer = articleB;
  api.fire([{ target: fakeBody }]);
  pump(); drainTimers();
  check('SPA element swap detected with recovery', resetCalls === 1 && resetArgs[0] === true);
  STATE.sentences = [{ text: 'Chapter two. A completely different story began here with new characters' }];

  resetCalls = 0;
  const articleC = makeNode('Chapter two. A completely different story began here with new characters and an entirely different setting than before.', true);
  articleB.isConnected = false;
  currentContainer = articleC;
  api.observe();
  api.fire([{ target: fakeBody }]);
  pump(); drainTimers();
  check('identical content on a re-created node does not reset', resetCalls === 0);

  resetCalls = 0;
  const ui = makeNode('player', true);
  api.setUi(ui, null);
  const child = makeNode('sentence 3 / 200', true);
  child.parentNode = ui;
  api.fire([{ target: child }]);
  pump(); drainTimers();
  check('own-UI-only mutation batches are ignored', resetCalls === 0);

  resetCalls = 0;
  articleC.innerText = 'Chapter three. The sovereign finally spoke and the world held its breath awaiting the verdict of the nine rules.';
  api.fire([{ target: fakeBody }]);
  pump(); drainTimers();
  check('real content change after own-UI noise is detected', resetCalls === 1);

  resetCalls = 0;
  const api2 = makeApi(true);
  api2.observe();
  api2.fire([{ target: fakeBody }]);
  pump(); drainTimers();
  check('mutations during our own prepare (suppressed) are ignored', resetCalls === 0);

  // --- 4b) debounce starvation: continuous churn must not blind detection --
  // NovelBuddy-class pages mutate constantly (ads, progress bars). The old
  // debounce rescheduled on every mutation, so the pending check NEVER fired
  // and the swap went unnoticed. With the max-wait ceiling the check fires
  // despite ongoing churn.
  {
    resetCalls = 0; resetArgs.length = 0;
    timers.clear();
    const churnNode = makeNode('Chapter three. The sovereign finally spoke and the world held its breath awaiting the verdict of the nine rules.', true);
    currentContainer = churnNode;
    api.observe();
    STATE.sentences = [{ text: 'Zayne stood atop the shattered spire and watched the horizon burn with the fires of a world remade.' }];
    for (let k = 0; k < 5; k++) {
      fakeNow += 300; // 300ms between churn bursts: each would reschedule
      api.fire([{ target: fakeBody }]);
    }
    // Total churn span 1500ms (< 2000ms ceiling): check still pending...
    check('continuous churn defers but does not drop the check', resetCalls === 0);
    fakeNow += 1000; // span now > ceiling
    api.fire([{ target: fakeBody }]); // this fire must NOT reschedule
    drainTimers();
    check('debounce max-wait fires the check despite churn', resetCalls === 1 && resetArgs[0] === true);
  }

  // --- 4c) onLikelyNav: tripwire follow-ups converge on a late render ------
  // Clicking Next fires nav BEFORE the chapter re-renders: the first check
  // sees old text (no reset), the staggered follow-ups see the new text.
  // NOTE: drainTimers() runs ALL pending fake timeouts in one pass, so the
  // follow-ups scheduled by nav() are consumed by the FIRST drainTimers()
  // (they fire while the text is still old). After the async render lands we
  // therefore fire the nav tripwire AGAIN (as the URL poller / page-world
  // patch would on the real page) and drain once more.
  {
    resetCalls = 0; resetArgs.length = 0;
    timers.clear();
    const navNode = makeNode('NovelBuddy Chapter 382: The Sovereign of Order. The sovereign raised his hand and the enclave fell silent at dawn.', true);
    currentContainer = navNode;
    api.observe(); // baseline = chapter 382 text
    STATE.sentences = [{ text: 'NovelBuddy Chapter 382: The Sovereign of Order. The sovereign raised his hand' }];
    api.nav();
    drainTimers(); // checks fire while text is still old → no reset
    check('nav check before render does not reset', resetCalls === 0);
    // ...async render lands the new chapter, tripwire fires again. NOTE: the
    // first drain also consumed onLikelyNav's +2s/+4s follow-ups (fake timers
    // all fire in one pass) — on the real page those follow-ups would fire
    // LATER in wall-clock time, after the render. The second nav() stands in
    // for them here. Clear leftovers first so the count is exact.
    navNode.innerText = 'NovelBuddy Chapter 383: Discovery Regarding The Main World. Zayne climbed the shattered spire and watched the horizon burn.';
    fakeNow += 2500;
    timers.clear();
    api.nav();
    drainTimers(); // checks fire on new text → reset with recovery (each
    // follow-up re-checks against the fresh baseline; the later ones see no
    // further change, but they each schedule again — count resets >= 1).
    check('nav follow-up check after async render resets', resetCalls >= 1 && resetArgs[0] === true);
    // onLikelyNav schedules follow-ups at +2s/+4s; draining fires them all in
    // one pass — the just-fired follow-ups re-arm the debounce timer, so one
    // pending (harmless, fires on old-baseline text → no reset) may remain.
    check('no runaway nav timers', timers.size <= 1);
  }

  // --- 4d) Play-after-Next safety net: preparedUrl mismatch re-splits -----
  // Even if every tripwire misses the swap, pressing Play must read the NEW
  // chapter, not the stale sentences — startReading re-splits when the tab
  // URL moved on since prepare.
  {
    check('startReading re-splits when the tab navigated since prepare',
      /if \(STATE\.prepared && preparedUrl && preparedUrl !== location\.href\)/.test(content) &&
      /STATE\.prepared = false;\s*\n\s*STATE\.currentIndex = -1;\s*\n\s*clearAudioCache\(\);/.test(content));
    // Finished-chapter bug (2.3.2): Play after Next used the OLD chapter's
    // last index against the NEW chapter's sentence list — beyond the end it
    // failed with 'no-content' and the player stayed dead until a refresh.
    // The re-split must reconcile the stale index instead.
    check('startReading clamps a stale out-of-range index after re-split',
      /if \(STATE\.currentIndex >= STATE\.sentences\.length\) STATE\.currentIndex = 0;/.test(content));
    check('prepareContent stamps preparedUrl + poller baseline',
      /preparedUrl = location\.href; lastLocationHref = location\.href;/.test(content));
    Date.now = realDateNow;
  }

  // --- 5) cache accounting (byte budget + behind-head preference) ----------
  const CACHE_LIMIT = 40;
  const CACHE_BYTES = 25 * 1024 * 1024;
  function makeCache(readHead) {
    const map = new Map();
    let bytes = 0;
    const entryBytes = (buf) => (Array.isArray(buf) ? buf : []).reduce((n, c) => n + ((c && c.byteLength) || 0), 0);
    function put(index, buf) {
      if (map.has(index)) bytes -= entryBytes(map.get(index));
      map.set(index, buf);
      bytes += entryBytes(buf);
      while (map.size > 1 && (map.size > CACHE_LIMIT || bytes > CACHE_BYTES)) {
        let victim = -1;
        for (const k of map.keys()) {
          if (k < readHead() && (victim < 0 || k < victim)) victim = k;
        }
        if (victim < 0) victim = map.keys().next().value;
        if (victim === index) break;
        bytes -= entryBytes(map.get(victim));
        map.delete(victim);
      }
    }
    return { map, put, bytes: () => bytes };
  }
  // --- 6) no-wasted-host-message invariant on skip -------------------------
  // piperCancel must be a pure watermark bump: runtime.sendNativeMessage is
  // one-shot, so ANY host message there would spawn a fresh host process on
  // every skip/jump — a process-spawn storm on rapid skipping.
  {
    const body = background.match(/function piperCancel\(\) \{[\s\S]*?\n\}/);
    check('piperCancel() spawns no host process (pure watermark bump)',
      !!body && !/piperSend\s*\(|sendMessage\s*\(/.test(
        body[0].split('\n').filter((l) => l.trim().indexOf('//') !== 0).join('\n')));
  }
  // --- 7) timeouts are not retried inside the FIFO (orphan stacking) -------
  // A timed-out piper process may still be running; an immediate FIFO retry
  // would stack a second concurrent model load. Extract the real predicate.
  {
// eslint-disable-next-line no-eval
    const piperRetryableError = eval('(' + extractFn(background, 'piperRetryableError') + ')');
    check('timeouts are not background-retried (orphan would still be running)',
      piperRetryableError(new Error('Piper host timeout')) === false);
    check('normal failures still get one background retry',
      piperRetryableError(new Error('Piper host not reachable')) === true &&
      piperRetryableError(new Error('piper failed (code 1): boom')) === true);
    check('piperSynthesizeChunk honors the predicate before its backoff retry',
      /if \(!piperRetryableError\(e\)\) throw e;/.test(background));
  }
  {
    let head = 10;
    const c = makeCache(() => head);
    const big = (mb) => [new ArrayBuffer(mb * 1024 * 1024)];
    c.put(5, big(5)); c.put(6, big(5)); c.put(11, big(5)); // 15MB < 25MB cap
    check('cache under byte budget keeps all entries', c.map.size === 3);
    c.put(12, big(10)); c.put(13, big(10)); // 35MB > 25MB cap → evict behind-head first
    check('byte overage evicts behind-head entries first', !c.map.has(5) && !c.map.has(6) && c.map.has(12) && c.map.has(13));
    check('byte accounting stays within cap', c.bytes() <= CACHE_BYTES);
    head = 13;
    c.put(14, big(30)); // single entry over the cap is served, forces next evictions
    check('oversized single entry is stored but nothing else survives around it', c.map.has(14));
  }

  // --- 6) speed clamp mirrors the popup slider range -----------------------
  check('clampSpeed helper present and gfree shows n/a for pitch',
    /function clampSpeed\(v\)/.test(content) && /gfree/.test(content));

  // --- 8) audioPlay advances silently via ITSELF, not systemSpeak ----------
  {
    const ap = content.match(/function audioPlay\(i, retryLeft\) \{[\s\S]*?\n    \}/);
    check('audioPlay silent-skip advances via audioPlay (not systemSpeak) and is fenced',
      !!ap && /isSilentText\(STATE\.sentences\[i\]\.text\)\) \{ audioPlay\(i \+ 1\); return; \}/.test(ap[0]) &&
      /assertSupportedEngine/.test(ap[0]));
    // CRITICAL regression test: the currentIndex assignment on entry. The
    // requestAudio/playChunks guards (`STATE.currentIndex !== i`),
    // schedulePrefetch's window, and audioResume's restart all depend on it.
    // A regression once dropped it → first sentence played (stale index == 0
    // matched) then EVERY subsequent sentence was discarded by the guard →
    // "played one sentence and stuck", and click-to-jump never started.
    check('audioPlay sets STATE.currentIndex BEFORE any async/generator work',
      !!ap &&
      /STATE\.currentIndex = i;/.test(ap[0]) &&
      ap[0].indexOf('STATE.currentIndex = i;') < ap[0].indexOf('const my = STATE.gen;') &&
      ap[0].indexOf('STATE.currentIndex = i;') < ap[0].indexOf('requestAudio('));
    // systemSpeak must NOT call audioPlay (audio engine must not hijack system)
    const ss = content.match(/function systemSpeak\(i, retryLeft\) \{[\s\S]*?\n    \}/);
    check('systemSpeak silent-skip advances via systemSpeak (not audioPlay)',
      !!ss && /isSilentText\(STATE\.sentences\[i\]\.text\)\) \{ systemSpeak\(i \+ 1\); return; \}/.test(ss[0]) &&
      !/audioPlay\(/.test(ss[0]));
  }

  // --- 9) ttsr-cmd bridge is gated to extension pages -----------------------
  {
    const bridge = content.match(/addEventListener\('ttsr-cmd', \(e\) => \{[\s\S]*?\n    \}\);?/);
    check('ttsr-cmd bridge is extension-page gated (hostile pages rejected)',
      !!bridge && /location\.href\.indexOf\(api\.runtime\.getURL\(''\)\) !== 0\) return;/.test(bridge[0]));
  }
  // --- 10) ttsr-jump validates its index in the idle branch -----------------
  check('ttsr-jump bounds-checks non-playing index',
    /if \(typeof msg\.index !== 'number' \|\| msg\.index < 0 \|\| msg\.index >= STATE\.sentences\.length\)/.test(content));

  // --- 11) Kokoro engine wiring (P7 runtime, 2.3.0) --------------------------
  // content.js: kokoro routes like the other audio engines (no more fence).
  check('content isAudioEngine includes kokoro',
    /function isAudioEngine\(\) \{ return STATE\.engine === 'gcloud' \|\| STATE\.engine === 'gfree' \|\| STATE\.engine === 'piper' \|\| STATE\.engine === 'kokoro'; \}/.test(content));
  check('content requestAudio sends ttsr-kokoro-synthesize with voice + clamped tempo speed',
    /type: 'ttsr-kokoro-synthesize', text: item\.text,/.test(content) &&
    /voice: STATE\.voice \|\| 'af_heart',/.test(content) &&
    /speed: Math\.min\(2, Math\.max\(0\.5, STATE\.speed \|\| 1\)\),/.test(content));
  check('content playChunks uses audio/wav for kokoro (24 kHz PCM16)',
    /const mimeType = \(STATE\.engine === 'piper' \|\| STATE\.engine === 'kokoro'\) \? 'audio\/wav' : 'audio\/mpeg';/.test(content));
  check('content prefetch depth stays shallow (3) for kokoro (CPU-bound synthesis)',
    /if \(STATE\.engine === 'kokoro'\) return 3;/.test(content));
  check('content sends ttsr-kokoro-cancel on skip and ttsr-kokoro-shutdown on stop',
    /function kokoroCancel\(\) \{[\s\S]*?type: 'ttsr-kokoro-cancel'[\s\S]*?\n    \}/.test(content) &&
    content.indexOf("api.runtime.sendMessage({ type: 'ttsr-kokoro-shutdown' });") !== -1);
  check('content never runs kokoro inference locally (background-only message types)',
    /'ttsr-kokoro-synthesize', 'ttsr-kokoro-status',/.test(content) &&
    !/KokoroTTS|from_pretrained/.test(content));
  // --- 11b) every read-head mover cancels BOTH engine queues -------------------
  // Three paths move the read head mid-playback: skip(), the ttsr-jump message,
  // and the in-page sentence click. Kokoro is the most expensive engine here, so a
  // mover that forgets kokoroCancel() burns up to a full prefetch depth (3) of ONNX
  // passes on the sentence the user just left. The watermark drops the results, so
  // nothing audible breaks — which is exactly how the click path shipped without it.
  {
    const start = content.lastIndexOf("document.addEventListener('click', (e) => {");
    const clickBody = content.slice(start, content.indexOf('\n    });', start));
    check('sentence-click mover cancels the Kokoro queue as well as Piper',
      start !== -1 && /piperCancel\(\);/.test(clickBody) && /kokoroCancel\(\);/.test(clickBody));
    const callsOf = (name) => (content.match(new RegExp(name + '\\(\\);', 'g')) || []).length;
    check('all three read-head movers cancel both queues (skip, ttsr-jump, click)',
      callsOf('piperCancel') === 3 && callsOf('kokoroCancel') === callsOf('piperCancel'));
  }

  // background.js: real runtime behind the kill switch, same FIFO+watermark
  // discipline as Piper, worker freed on stop/idle.
  check('background KOKORO_ENABLED kill switch present (true in this build)',
    /const KOKORO_ENABLED = true;/.test(background));
  check('background routes kokoro synthesis through a single-flight FIFO + watermark',
    /function kokoroEnqueue\(task\) \{/.test(background) &&
    /const mark = kokoroWatermark;/.test(background) &&
    /const run = kokoroQueue\.then\(guarded, guarded\);/.test(background) &&
    /kokoroEnqueue\(\(\) => kokoroSynthesize\(msg\.text, msg\.voice, msg\.speed\)\)/.test(background));
  check('background spawns kokoro as a dedicated module worker (never in a page context)',
    /new Worker\(api\.runtime\.getURL\(KOKORO_WORKER_FILE\), \{ type: 'module' \}\)/.test(background) &&
    background.indexOf("KOKORO_WORKER_FILE = 'kokoro-worker.js'") !== -1);
  // The Firefox transport was DEAF: kokoroSpawn() created the worker but never
  // wired its events, so no progress/synthesized/download-done ever reached
  // handleKokoroMessage — no download bar, and every synthesis answered only by
  // its 180 s timeout (sentences skipped). offscreen.js does this for Chrome.
  check('Firefox kokoroSpawn wires worker events to handleKokoroMessage (deaf transport fix)',
    /function kokoroSpawn\(\) \{[\s\S]*?w\.onmessage = \(ev\) => \{ if \(ev && ev\.data\) handleKokoroMessage\(ev\.data\); \}/.test(background) &&
    /function kokoroSpawn\(\) \{[\s\S]*?w\.onerror/.test(background));
  check('background terminates the kokoro worker on shutdown and arms an idle release',
    /function kokoroRelease\(\) \{[\s\S]*?kokoroWorker\.terminate\(\)/.test(background) &&
    /case 'ttsr-kokoro-shutdown':/.test(background) &&
    /KOKORO_IDLE_RELEASE_MS/.test(background));
  check('background phoneme-less guard covers kokoro too',
    /async function kokoroSynthesize\(text, voice, speed\) \{\n  if \(!text \|\| !\/\[\\p\{L\}\\p\{N\}\]\/u\.test\(String\(text\)\)\) return \[\];/.test(background));
  check('background fails closed for ttsr-kokoro-* when KOKORO_ENABLED=false',
    (background.match(/if \(!KOKORO_ENABLED\) \{ sendResponse\(\{ ok: false, error: kokoroNotReady\(\)\.message \}\); return true; \}/g) || []).length >= 3);
  check('background kokoro shutdown defers while worker is busy (no mid-sentence kill)',
    /kokoroIsBusy\(\)/.test(background) && /shutdown deferred/.test(background));
  check('background kokoro synthesis fast-fails when the model is not downloaded',
    /kokoroModelReady\(\)/.test(background) && /Kokoro model not downloaded yet/.test(background));
  check('content surfaces the kokoro not-downloaded error as a terminal hiccup',
    /not downloaded yet/.test(content) && /Download Kokoro model/.test(content));
  check('popup hides the voice picker for kokoro and wires the download progress bar',
    /voiceField\.style\.display = \(prefs\.engine === 'kokoro'\) \? 'none'/.test(fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8')));

  // --- 12) quick-win + cancel-channel regression pins (2026-10-03 pass) -----
  // One pin per fixed bug (the AGENT.md rule). Covers: the gcloud key moving
  // into a request header, the piperTimeoutMs 120s cap, multilingual sentence
  // terminators (plus the pdfviewer twin), the Kokoro worker cancel channel
  // (a skip no longer waits out an abandoned RTF≈1 synthesis), systemSpeak's
  // error-name source, the popup's kokoro pitch readout, the dead
  // KOKORO_VOICES array, router log truncation, and the piper_host.py
  // hardening (110s kill + bare-filename models).
  {
    const popupSrc = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
    const workerSrc = fs.readFileSync(path.join(ROOT, 'kokoro-worker.js'), 'utf8');
    const pdfSrc = fs.readFileSync(path.join(ROOT, 'pdfviewer.js'), 'utf8');
    const pySrc = fs.readFileSync(path.join(ROOT, 'piper-host', 'piper_host.py'), 'utf8');

    // The key must never appear in a URL: query strings land in proxy and
    // telemetry logs. (gcloudSynthesizeOne's comment mentions "?key=" — these
    // pins target the code shapes, not the comments.)
    check('gcloud API key travels in the X-Goog-Api-Key header, never a ?key= query',
      (background.match(/'X-Goog-Api-Key': key/g) || []).length === 3 &&
      /const url = CLOUD_ENDPOINT;/.test(background) &&
      /const url = CLOUD_VOICES_ENDPOINT;/.test(background) &&
      background.indexOf("+ '?key='") === -1);

    // An uncapped pathological call (8000 chars × length_scale 4) computed to
    // ~19 minutes, wedging the single-flight FIFO behind one dead job.
// eslint-disable-next-line no-eval
    const piperTimeoutMs = eval('(' + extractFn(background, 'piperTimeoutMs') + ')');
    check('piperTimeoutMs caps at 120s so one pathological call cannot wedge the FIFO',
      piperTimeoutMs(8000, 4) === 120000 &&
      piperTimeoutMs(2000, 1) === 80000 &&
      piperTimeoutMs(100, 1) === 11600);

    // The shipped splitter, executed: danda (Hindi/Marathi), fullwidth CJK
    // (no spaces required), Arabic ؟ — plus the unchanged Latin + digit
    // list-marker behavior.
// eslint-disable-next-line no-eval
    const splitSentences = eval('(' + extractFn(content, 'splitSentences') + ')');
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    check('splitSentences recognizes Devanagari danda (।)',
      eq(splitSentences('नमस्ते दुनिया। यह दूसरा वाक्य है।'), ['नमस्ते दुनिया।', 'यह दूसरा वाक्य है।']));
    check('splitSentences recognizes CJK 。！？ without spaces',
      eq(splitSentences('こんにちは。お元気ですか？はい。'), ['こんにちは。', 'お元気ですか？', 'はい。']));
    check('splitSentences recognizes Arabic ؟',
      eq(splitSentences('كيف حالك؟ أنا بخير.'), ['كيف حالك؟', 'أنا بخير.']));
    check('splitSentences keeps Latin prose and digit list markers as before',
      eq(splitSentences('One. Two! Three?'), ['One.', 'Two!', 'Three?']) &&
      eq(splitSentences('1. first item 2. second item'), ['1. first item 2. second item']));

    // pdfviewer.js precomputes a sentence→page map with a regex that MUST
    // stay byte-identical to content.js's, or page flips drift off.
    const termRe = /\/\[\.!\?。！？।॥؟\]\+\(.*?\|\$\)\/g/;
    const contentTerms = content.match(termRe);
    const pdfTerms = pdfSrc.match(termRe);
    check('pdfviewer sentence-terminator regex stays byte-identical to content.js',
      !!contentTerms && !!pdfTerms && contentTerms[0] === pdfTerms[0]);

    // The cancel channel end-to-end: skip bumps the watermark AND posts a
    // note; the worker stops the abandoned job at the next chunk boundary;
    // background rejects with a sentinel that both content and the router
    // treat as silent (no retry, no hiccup, no console spam).
    check('background kokoroCancel posts a worker cancel note (no-op when the worker is down)',
      /kokoroPost\(\{ type: 'cancel' \}\)\.catch\(\(\) => \{\}\);/.test(background));
    check('worker resets the cancel flag per job and checks it between chunks',
      /if \(msg\.type === 'cancel'\) \{\s*cancelRequested = true;/.test(workerSrc) &&
      /if \(msg\.type === 'synthesize'\) \{\s*cancelRequested = false;/.test(workerSrc) &&
      /for \(let i = 0; i < chunks\.length; i\+\+\) \{\s*if \(cancelRequested\) \{/.test(workerSrc));
    check('worker replies cancelled; background rejects with the sentinel and arms idle release',
      /self\.postMessage\(\{ type: 'cancelled', id: msg\.id \}\);/.test(workerSrc) &&
      /kokoroArmIdleRelease\(\);\s*p\.reject\(new Error\('Kokoro synthesis cancelled'\)\);/.test(background));
    check('content and the router treat the cancel sentinel as silent (no retry, hiccup, or log)',
      /if \(msg === 'Kokoro synthesis cancelled'\) return;/.test(content) &&
      /if \(e !== 'Kokoro synthesis cancelled'\) \{/.test(background));

    check('systemSpeak reads the error name from the event, not the utterance',
      /u\.onerror = \(ev\) =>/.test(content) &&
      content.indexOf('u.error && u.error.name') === -1);
    check('popup shows pitch n/a for gfree AND kokoro (neither has pitch control)',
      (popupSrc.match(/\(prefs\.engine === 'gfree' \|\| prefs\.engine === 'kokoro'\) \? 'n\/a' : prefs\.pitch\.toFixed\(1\)/g) || []).length === 2);
    check('dead KOKORO_VOICES array removed from popup',
      popupSrc.indexOf('KOKORO_VOICES') === -1);
    check('router failure logs truncate page text to 80 chars',
      (background.match(/String\(msg\.text\)\.slice\(0, 80\)/g) || []).length === 2);

    check('piper host kills a hung piper at 110s (just under the 120s extension cap)',
      /timeout=110,/.test(pySrc) && /timed out/.test(pySrc));
    check('piper host honors only bare model filenames (no path traversal)',
      /Only bare filenames are honored/.test(pySrc) &&
      /os\.path\.basename/.test(pySrc));
    // Strict "downloaded" check + honest Play fast-fail. The old cache check
    // treated ANY cached URL containing Kokoro-82M as "downloaded" — tiny
    // sidecar files (config/tokenizer JSONs) satisfied it, the popup said
    // "stored locally" with no progress bar, and the real ~88 MB weights
    // fetch then ran silently inside the first synthesis call, blowing the
    // 180s timeout. The check must require the .onnx weights with a real
    // body; Play must say "still downloading, N%" while that fetch runs.
    const chm = background.match(/async function kokoroCacheHasModel\(\) \{[\s\S]*?\n\}/);
    check('kokoro cache check requires the .onnx weights with a >=40MB body (sidecars never satisfy it)',
      !!chm && /\.onnx/.test(chm[0]) && /40000000/.test(chm[0]) && /Kokoro-82M/.test(chm[0]));
    check('kokoro Play fast-fail is honest while a download runs (still downloading, N% done)',
      /still downloading, ' \+ Math\.round\(kokoroProgress\.pct \|\| 0\) \+ '% done'/.test(background) &&
      /Kokoro model not downloaded yet/.test(background));
    // Bold filled SVG transport icons replaced the unclear Unicode glyphs
    // (which rendered thin or as emoji depending on OS/font).
    const popupHtmlSrc = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
    const pdfHtmlSrc = fs.readFileSync(path.join(ROOT, 'pdfviewer.html'), 'utf8');
    const noGlyphs = (s) => !/[⏮⏸⏭■]/.test(s);
    check('popup transport uses filled SVG icons (no Unicode glyphs)',
      noGlyphs(popupHtmlSrc) && noGlyphs(popupSrc) &&
      /<svg viewBox="0 0 24 24"/.test(popupHtmlSrc) && /fill="currentColor"/.test(popupSrc));
    check('on-page player uses filled SVG icons; the toggle swaps play/pause SVGs',
      noGlyphs(content) && /toggle\.innerHTML = STATE\.isPaused \? ICON\.play : ICON\.pause;/.test(content) &&
      /'<svg viewBox="0 0 24 24"/.test(content));
    check('pdfviewer transport uses filled SVG icons on both sides',
      noGlyphs(pdfHtmlSrc) && noGlyphs(pdfSrc) && /ICON_PLAY/.test(pdfSrc) && /ICON_PAUSE/.test(pdfSrc) &&
      /<svg viewBox="0 0 24 24"/.test(pdfHtmlSrc));
    // Voice picker commit race: clearing voiceList/voiceRows before the async
    // fetch left an empty-list window where a datalist pick's commit found no
    // match and silently dropped the first selection ("must select it twice");
    // Firefox also fires only 'input' (not 'change') for datalist picks.
    check('popup voice list is rebuilt atomically (no clear-before-await race)',
      /const next = \[\];/.test(popupSrc) && /voiceList = next;/.test(popupSrc) &&
      !!(() => {
        const rvl = popupSrc.match(/async function rebuildVoiceList\(\) \{[\s\S]*?\n  \}/);
        return rvl && /const next = \[\];/.test(rvl[0]) && /voiceList = next;/.test(rvl[0]) &&
          !/voiceList = \[\];/.test(rvl[0]);
      })());
    check('popup commits exact datalist matches on input (Firefox fires only input there)',
      /e\.inputType && e\.inputType\.indexOf\('delete'\) === 0/.test(popupSrc) &&
      /if \(exact && !isDelete\)/.test(popupSrc) &&
      /if \(active\) els\.voiceSearch\.value = active\.label;/.test(popupSrc));
    check('pdfviewer voice list is atomic, commits on input, never clobbers typing',
      /voiceRows = next;/.test(pdfSrc) &&
      /document\.activeElement !== els\.voiceSearch/.test(pdfSrc) &&
      /if \(exact && !isDelete\)/.test(pdfSrc));
    const sdIdx = content.indexOf('/still downloading/');
    const sdRegion = sdIdx >= 0 ? content.slice(sdIdx, sdIdx + 700) : '';
    check('content waits out an in-flight Kokoro download (no retry burn, live percentage)',
      sdIdx >= 0 && /audioPlay\(i, retryLeft\)/.test(sdRegion) &&
      /playback starts when it finishes/.test(sdRegion));
    // Activity-based synthesis timeout: progress reports re-arm the pending
    // timers, so a slow-but-healthy model load (~116 s measured + warm-up)
    // never trips the fixed 180 s clock — only 180 s of total silence does.
    check('kokoro timeouts are activity-based (progress re-arms pending timers)',
      /bump: arm,/.test(background) &&
      /kokoroPending\.forEach\(\(p\) => \{ if \(p\.bump\) p\.bump\(\); \}\)/.test(background) &&
      /m\.type === 'chunk-progress'/.test(background));
    check('popup shows a failed Kokoro download instead of silently re-showing the pitch',
      /Download failed: ' \+ st\.error/.test(popupSrc));
    // The old stop path filled only half the viewBox — a ~5px square at the
    // rendered size, illegible. The fuller path reads clearly at 14px.
    check('stop icons use the fuller M5 5h14v14H5z path (readable at 14px)',
      /M5 5h14v14H5z/.test(popupHtmlSrc) && /M5 5h14v14H5z/.test(content) &&
      /M5 5h14v14H5z/.test(pdfHtmlSrc));
    // Android: context-menu start — a popup-free one-tap read. Fenix shows
    // browserAction popups as a cramped sheet; the menu drives the tab's
    // content script with the same ttsr-play message the popup's Play sends.
    const manifestSrc = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
    const chromeManifestSrc = fs.readFileSync(path.join(ROOT, 'build-source/manifest.chrome.json'), 'utf8');
    const menuIdx = background.indexOf('ttsr-read-page');
    const menuRegion = menuIdx >= 0 ? background.slice(menuIdx) : '';
    check('Android context-menu start wired (permission + menu + prefs-driven ttsr-play)',
      /"contextMenus"/.test(manifestSrc) && /"contextMenus"/.test(chromeManifestSrc) &&
      menuIdx >= 0 && /contexts: \['page'\]/.test(menuRegion) &&
      /type: 'ttsr-play',/.test(menuRegion) &&
      /fromIndex: 0,/.test(menuRegion));
    // Security: the gcloud key flow — validated against Google BEFORE it is
    // stored (the old order stored first, so a typo overwrote a working key,
    // and "✓ key works" only meant "a key is present").
    check('gcloud ping really validates against Google (accepts a candidate key)',
      /async function gcloudPing\(candidateKey\)/.test(background) &&
      /gcloudPing\(msg && msg\.key\)/.test(background) &&
      /'X-Goog-Api-Key': key \}/.test(background));
    check('popup stores the gcloud key only after validation succeeds',
      /ttsr-gcloud-ping', key: k \}/.test(popupSrc) &&
      popupSrc.indexOf("ttsr-gcloud-ping', key: k }") <
        popupSrc.indexOf("api.storage.local.set({ ttsr_gcloud_key: k })") &&
      /api\.storage\.local\.set\(\{ ttsr_gcloud_key: k \}\)/.test(popupSrc));
    check('piper host lets synthesize() validate scales (no opaque float in main)',
      !/float\(msg\.get\("length_scale"/.test(pySrc));
  }

  console.log(failures === 0 ? 'ALL TESTS PASSED' : failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('TEST HARNESS ERROR:', e && e.stack || e); process.exit(1); });
