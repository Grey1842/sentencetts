// Background module for SentenceTTS Reader (MV3).
//
// Four background-side TTS engines live here so the page never sees the
// credentials or runs the network/binary calls:
//
//   1. Google Cloud TTS    (real neural voices incl. en-IN; needs an API key)
//   2. Google Free (translate_tts) (no key, instant; one accent, <=200c/chunk)
//   3. Piper TTS           (offline neural; via a Native Messaging host)
//   4. Kokoro TTS          (offline neural; in-browser WASM, §3b — the model
//                           is download-on-first-use, inference in a worker)
//
// The content script plays whatever ArrayBuffer we return via an <audio>
// element and does its own highlighting. "System" (browser speechSynthesis)
// voices are handled entirely in the content script — they don't pass here.

const api = typeof browser !== 'undefined' ? browser : chrome;

// True in Firefox (moz-extension://), false in Chrome/Edge (chrome-extension://).
// Drives browser-specific native-messaging install notes and file-access text.
const IS_FIREFOX = api.runtime.getURL('').indexOf('moz-extension://') === 0;

// isAllowedFileSchemeAccess exists in both browsers but in different modes:
// Firefox browser.* is promise-only, Chrome chrome.* is callback-only. Look at
// the API surface once and pick the mode that answers.
function isAllowedFileScheme() {
  return new Promise((resolve) => {
    try {
      const fn = api.extension.isAllowedFileSchemeAccess;
      if (IS_FIREFOX) {
        Promise.resolve(fn()).then((v) => resolve(v === true), () => resolve(false));
      } else {
        fn((v) => resolve(v === true));
      }
    } catch (e) {
      resolve(false);
    }
  });
}

// ============================================================
// shared helpers
// ============================================================

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Native messaging timeout guard
// Piper synthesis time scales with chunk length and length_scale (slower speech = longer audio = more inference).
// Measured on this machine (en_US-arctic-medium.onnx):
//   2000 chars, length_scale=2.0  → ~18.3s
//   2000 chars, length_scale=1.0  → ~11.9s
//   2000 chars, length_scale=0.5  → ~8.9s
// Base ~0.009s/char at length_scale=1.0. Use 4x margin + 2s fixed overhead for model load.
function piperTimeoutMs(textLength, lengthScale) {
  const baseMsPerChar = 9;  // ~9ms per char at length_scale=1.0
  const overheadMs = 2000;  // model loading + connection overhead
  const margin = 4;         // 4x safety margin
  return Math.ceil((textLength * baseMsPerChar * lengthScale + overheadMs) * margin);
}

// Split text into <=max-char chunks at word boundaries.
function chunkText(text, max) {
  const words = text.split(/\s+/);
  const chunks = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max) {
      if (cur) chunks.push(cur.trim());
      if (w.length > max) {
        // a single word longer than the cap — hard-split it
        for (let i = 0; i < w.length; i += max) chunks.push(w.slice(i, i + max));
        cur = '';
      } else {
        cur = w;
      }
    } else {
      cur = (cur ? cur + ' ' : '') + w;
    }
  }
  if (cur) chunks.push(cur.trim());
  return chunks;
}

// ============================================================
// 1) Google Cloud Text-to-Speech  (API key required)
// ============================================================

const CLOUD_ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';

// Google's plain-text `input.text` is capped around 5000 bytes; a single
// sentence longer than that previously failed as a whole and was skipped
// (retry couldn't help — it failed the same way every time). Chunked like
// the other engines now, each chunk as its own ArrayBuffer, played
// back-to-back by the content script.
const GCLOUD_MAX_CHARS = 1000;

async function getCloudKey() {
  const { ttsr_gcloud_key } = await api.storage.local.get('ttsr_gcloud_key');
  if (!ttsr_gcloud_key) throw new Error('No Google Cloud API key set. Add one in the popup.');
  return String(ttsr_gcloud_key).trim();
}

async function gcloudSynthesizeOne(text, key, voice, rate, pitchSemitones) {
  const url = CLOUD_ENDPOINT + '?key=' + encodeURIComponent(key);

  const languageCode = (voice || '').split('-').slice(0, 2).join('-') || 'en-IN';
  const body = {
    input: { text },
    voice: { languageCode, name: voice },
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate: rate,      // 0.25–4.0
      pitch: pitchSemitones,  // -20.0–+20.0 semitones
    },
  };

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error('Network error contacting Google TTS: ' + (e && e.message));
  }

  if (!resp.ok) {
    let msg = 'HTTP ' + resp.status;
    try {
      const j = await resp.json();
      if (j.error) msg = (j.error.message || j.error.status || msg);
    } catch (_) { /* not JSON */ }
    throw new Error('Google TTS error: ' + msg);
  }
  const data = await resp.json();
  if (!data || !data.audioContent) throw new Error('Google TTS returned no audio');
  const buf = base64ToArrayBuffer(data.audioContent);
  if (!buf || buf.byteLength === 0) throw new Error('Google TTS returned empty audio');
  return buf;
}

async function gcloudSynthesize(text, voice, rate, pitchSemitones) {
  const key = await getCloudKey();
  const chunks = chunkText(text, GCLOUD_MAX_CHARS);
  const parts = [];
  for (const c of chunks) {
    parts.push(await gcloudSynthesizeOne(c, key, voice, rate, pitchSemitones));
  }
  return parts;
}

async function gcloudListVoices() {
  const key = await getCloudKey();
  const url = 'https://texttospeech.googleapis.com/v1/voices?key=' + encodeURIComponent(key);
  let resp;
  try {
    resp = await fetch(url);
  } catch (e) {
    throw new Error('Network error listing Google voices: ' + (e && e.message));
  }
  if (!resp.ok) {
    let msg = 'HTTP ' + resp.status;
    try { const j = await resp.json(); if (j.error) msg = j.error.message || msg; } catch (_) {}
    throw new Error('Google voices list error: ' + msg);
  }
  const data = await resp.json();
  const voices = (data.voices || []).map((v) => ({
    name: v.name,
    lang: (v.languageCodes && v.languageCodes[0]) || '',
    gender: v.ssmlGender || '',
  }));
  return voices;
}

// ============================================================
// 2) Google Free (translate.google.com/translate_tts)
//    No key. One accent per language. <=200 chars per request,
//    so longer text is chunked and each chunk's MP3 is returned as
//    a separate ArrayBuffer, played back-to-back by the content
//    script (no byte-level stitching).
// NOTE: unsupported endpoint — may rate-limit. No speed/pitch control.
//       One retry with a short backoff per chunk (see freeSynthesizeOne).
// ============================================================

const FREE_ENDPOINT = 'https://translate.google.com/translate_tts';

async function freeSynthesizeOne(text, lang) {
  const u =
    FREE_ENDPOINT +
    '?ie=UTF-8&q=' + encodeURIComponent(text) +
    '&tl=' + encodeURIComponent(lang || 'en') +
    '&total=1&idx=0&client=tw-ob&textlen=' + encodeURIComponent(String(text.length));

  async function attempt() {
    let resp;
    try {
      resp = await fetch(u, { method: 'GET' });
    } catch (e) {
      throw new Error('Network error contacting translate_tts: ' + (e && e.message));
    }
    if (!resp.ok) {
      if (resp.status === 429) throw new Error('Rate limited by Google Free TTS (429)');
      throw new Error('translate_tts returned HTTP ' + resp.status);
    }
    const buf = await resp.arrayBuffer();
    if (!buf || buf.byteLength === 0) throw new Error('translate_tts returned empty audio');
    return buf;
  }

  // One retry with a short backoff before giving up on a chunk (item 5).
  try {
    return await attempt();
  } catch (e) {
    await sleep(500);
    return await attempt();
  }
}

async function gfreeSynthesize(text, lang) {
  // translate_tts caps near 200 chars. Chunk and return one ArrayBuffer
  // per chunk — the content script plays them back-to-back (no stitching).
  const chunks = chunkText(text, 190);
  const parts = [];
  for (const c of chunks) {
    parts.push(await freeSynthesizeOne(c, lang));
  }
  return parts;
}

// ============================================================
// 3b) Kokoro TTS (in-browser neural, download-on-first-use — P7)
//    Kokoro is the ONLY path to offline neural voices on Firefox for Android
//    (native messaging is desktop-only), and a zero-setup offline neural
//    option on desktop. Shipped in 2.3.0 after the RTF spike (see
//    KOKORO_SPIKE.md): RTF ~0.9-1.0 on a 1.2 GHz i3 means 2x playback-rate
//    gaps on the very lowest-end machines — the user accepted that and will
//    validate on mid/high-end hardware.
//
//    Architecture (constraints from the spike, all honored):
//      - Inference NEVER in content.js. It runs in a dedicated module worker
//        (kokoro-worker.js) spawned here, over the vendored kokoro-js web
//        bundle + local ORT wasm (vendor/kokoro/). No remote code: the only
//        runtime fetches are DATA (88 MB q8 model + ~522 KB voice files) from
//        huggingface.co, gated behind an explicit popup download consent.
//      - The model persists in Cache Storage (transformers.js browser cache),
//        so the download happens exactly once per device.
//      - Same discipline as Piper: all synthesis through ONE FIFO with a
//        monotonic cancel watermark; worker is terminated (RAM freed) on
//        stop / engine switch-away signal / 5-minute idle.
//      - KOKORO_ENABLED stays as a build-time kill switch: flipping it false
//        makes every ttsr-kokoro-* message fail closed with a tellable error.
// ============================================================
const KOKORO_ENABLED = true; // build-time kill switch (P7 runtime shipped in 2.3.0)
const KOKORO_WORKER_FILE = 'kokoro-worker.js';
const KOKORO_DEFAULT_VOICE = 'af_heart';
const KOKORO_IDLE_RELEASE_MS = 5 * 60 * 1000; // free model RAM after 5 idle minutes
// Guard for the sendResponse channel: one Kokoro pass is RTF ~0.9-1 on a
// 1.2 GHz i3 (far lower on real hardware) + worst case a cold model load
// ~2 min (measured 116 s on the spike machine).
const KOKORO_SYNTH_TIMEOUT_MS = 180000;

let kokoroWorker = null;
let kokoroPending = new Map(); // job id -> { resolve, reject, timer }
let kokoroNextId = 1;
let kokoroWatermark = 0;
let kokoroQueue = Promise.resolve();
let kokoroProgress = { phase: 'idle', pct: 0, detail: '' };
let kokoroModelLoaded = false;
let kokoroLastError = '';
let kokoroIdleTimer = null;

function kokoroNotReady() {
  return new Error('Kokoro engine is disabled in this build (KOKORO_ENABLED=false — see the P7 memo in AGENT.md).');
}

function kokoroRelease() {
  if (kokoroWorker) {
    try { kokoroWorker.terminate(); } catch (e) {}
    kokoroWorker = null;
  }
  // Chrome: the worker lives in the offscreen document — closing it frees the
  // model's RAM and lets a later kokoroEnsureHost() recreate everything.
  if (!IS_FIREFOX && api.offscreen && api.offscreen.closeDocument) {
    try { api.offscreen.closeDocument(api.runtime.getURL('offscreen.html'))
      .catch(() => {}); } catch (e) {}
  }
  // Any in-flight synthesis dies with the worker; fail those callers cleanly.
  kokoroPending.forEach((p) => { clearTimeout(p.timer); p.reject(new Error('Kokoro worker released')); });
  kokoroPending.clear();
  if (kokoroIdleTimer) { clearTimeout(kokoroIdleTimer); kokoroIdleTimer = null; }
  kokoroModelLoaded = false;
  kokoroProgress = { phase: 'idle', pct: 0, detail: '' };
}

// True when synthesis can start right now without a download: model already
// in memory, or sitting in the transformers Cache Storage from an earlier
// session. null (cache unreadable) counts as ready — the worker will then
// just load what it needs, and lying "not downloaded" would block users.
async function kokoroModelReady() {
  if (kokoroModelLoaded) return true;
  if (kokoroProgress.phase === 'downloading' || kokoroProgress.phase === 'loading') return false;
  const cached = await kokoroCacheHasModel();
  return cached !== false;
}

function kokoroIsBusy() {
  // Never yank the worker while jobs are in flight or while it is
  // mid-download/mid-load — terminating it then is what produced
  // "Kokoro worker released" mid-sentence on Stop/content-reset.
  if (kokoroPending.size > 0) return true;
  return kokoroProgress.phase === 'downloading' || kokoroProgress.phase === 'loading';
}

function kokoroArmIdleRelease() {
  if (kokoroIdleTimer) clearTimeout(kokoroIdleTimer);
  kokoroIdleTimer = setTimeout(kokoroRelease, KOKORO_IDLE_RELEASE_MS);
}

// Chrome MV3's extension service worker has NO Worker constructor (verified:
// typeof Worker === 'undefined' in Chromium 153), so the inference worker
// cannot live here. There it runs inside an offscreen document
// (offscreen.html + offscreen.js, chrome.offscreen reason WORKERS) and every
// message is proxied over runtime messaging; Firefox's MV3 background is a
// real DOM page and keeps the direct in-page module worker. The state machine
// below (progress / pending jobs / errors) is identical for both transports.
let kokoroSpawning = null;

function kokoroEnsureHost() {
  if (kokoroWorker) return Promise.resolve(kokoroWorker);
  if (kokoroSpawning) return kokoroSpawning;
  // Never throw synchronously (a missing vendor file makes new Worker throw) —
  // callers are promise chains inside message handlers; a sync throw there
  // would kill the handler without answering the popup/content caller.
  try {
    kokoroSpawning = Promise.resolve(IS_FIREFOX ? kokoroSpawn() : kokoroSpawnOffscreen())
      .then((w) => { kokoroSpawning = null; return w; },
        (e) => { kokoroSpawning = null; throw e; });
  } catch (e) {
    kokoroSpawning = Promise.reject(e);
  }
  // Unstick guard: if the spawn promise settles while the worker that kicked
  // it off was already frozen mid-flight (Chrome MV3 suspends service workers
  // between tasks; a hanging createDocument + suspend = wedge), a later retry
  // would still wait on the dead promise. After a grace window beyond the
  // 15s readiness timeout, treat the spawn as wedged and reset.
  setTimeout(() => {
    if (kokoroSpawning && !kokoroWorker) {
      console.warn('[SentenceTTS][background][kokoro] spawn wedge detected — resetting');
      kokoroSpawning = null;
    }
  }, 20000);
  return kokoroSpawning;
}

function kokoroSpawn() {
  // Firefox only: DOM-window background page, Worker exists here.
  const w = new Worker(api.runtime.getURL(KOKORO_WORKER_FILE), { type: 'module' });
  kokoroWorker = w;
  return Promise.resolve(w);
}

async function kokoroSpawnOffscreen() {
  // Chrome only. createDocument is the source of truth: it resolves when the
  // document exists (already up, or after creating it) and survives service
  // worker restarts, so no cached "has offscreen" boolean is needed. The
  // runtime.onMessage listener at the bottom of this file receives everything
  // the offscreen bridge posts back.
  await api.offscreen.createDocument({
    url: api.runtime.getURL('offscreen.html'),
    reasons: ['WORKERS'],
    justification: 'Kokoro neural TTS: model download and WASM inference need Web Workers, which MV3 service workers do not provide.',
  });
  // Wait for the bridge's ready ping so the first kokoroPost cannot race the
  // document's own script evaluation. This handler is the ONLY responder to
  // the ping (sendResponse is what makes offscreen.js stop pinging).
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Kokoro offscreen document did not signal readiness')), 15000);
    const handler = (msg, _s, sendResponse) => {
      if (msg && msg.type === '__kokoroOffscreenReady') {
        clearTimeout(t);
        api.runtime.onMessage.removeListener(handler);
        if (typeof sendResponse === 'function') sendResponse({ ack: true });
        resolve();
      }
    };
    api.runtime.onMessage.addListener(handler);
  });
  kokoroWorker = { offscreen: true };
  return kokoroWorker;
}

function handleKokoroMessage(m) {
  if (m.type === 'progress') {
    kokoroProgress = { phase: m.phase, pct: m.pct, detail: m.detail };
    if (m.phase === 'ready') kokoroModelLoaded = true;
  } else if (m.type === 'synthesized') {
    let audio = m.audio;
    if (!audio && m.audioB64) {
      audio = m.audioB64.map(base64ToArrayBuffer); // offscreen transport
    }
    const p = kokoroPending.get(m.id);
    if (p) { kokoroPending.delete(m.id); p.resolve(audio || []); }
  } else if (m.type === 'synth-error') {
    const p = kokoroPending.get(m.id);
    if (p) { kokoroPending.delete(m.id); p.reject(new Error(m.error || 'Kokoro synthesis failed')); }
  } else if (m.type === 'download-done') {
    kokoroModelLoaded = true;
    kokoroProgress = { phase: 'ready', pct: 100, detail: '' };
  } else if (m.type === 'download-error') {
    kokoroLastError = m.error || 'Kokoro download failed';
    kokoroProgress = { phase: 'idle', pct: 0, detail: '' };
  } else if (m.type === '__kokoroError') {
    // Offscreen worker startup failure (bad import, missing vendor file, ...).
    const e = String(m.error || 'unknown error');
    console.error('[SentenceTTS][background][kokoro]', e);
    kokoroLastError = e;
    kokoroWorker = null;
    kokoroPending.forEach((p) => { clearTimeout(p.timer); p.reject(new Error(e)); });
    kokoroPending.clear();
  }
}

function kokoroPost(payload) {
  if (!kokoroWorker) return Promise.reject(new Error('Kokoro worker not running'));
  if (IS_FIREFOX) {
    try { kokoroWorker.postMessage(payload); return Promise.resolve(); }
    catch (e) { return Promise.reject(e); }
  }
  // Chrome: fire into the offscreen document (its listener responds void).
  return api.runtime.sendMessage({ type: '__kokoroToOffscreen', payload })
    .then(() => {}, (e) => { throw (e || new Error('Kokoro offscreen bridge unreachable')); });
}

function kokoroCall(payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    kokoroEnsureHost().then(() => {
      const id = kokoroNextId++;
      payload.id = id;
      const timer = setTimeout(() => {
        kokoroPending.delete(id);
        reject(new Error('Kokoro synthesis timed out'));
      }, timeoutMs);
      kokoroPending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      kokoroPost(payload).catch((e) => {
        kokoroPending.delete(id);
        clearTimeout(timer);
        reject(e);
      });
    }, reject);
  });
}

// Monotonic cancel watermark — same mechanism as piperCancel (see §3). No
// interrupt of an in-flight synthesis (can't abort inference mid-pass); queued
// jobs are dropped by the watermark, the running one finishes and its result
// is discarded by content's gen guard.
function kokoroCancel() {
  kokoroWatermark += 1;
}

function kokoroEnqueue(task) {
  const mark = kokoroWatermark;
  function guarded() {
    if (mark !== kokoroWatermark) return { stale: true };
    return task();
  }
  const run = kokoroQueue.then(guarded, guarded);
  kokoroQueue = run.catch(() => {}); // never let one failure poison the chain
  return run;
}

async function kokoroSynthesize(text, voice, speed) {
  if (!text || !/[\p{L}\p{N}]/u.test(String(text))) return [];
  // Fast-fail when the model was never downloaded: silently kicking off an
  // ~88 MB download + cold WASM load from a Play press looked like "Kokoro
  // plays nothing". The popup's Download button is the consent gate; direct
  // users there instead of auto-downloading.
  if (!(await kokoroModelReady())) {
    throw new Error('Kokoro model not downloaded yet — open the popup and press "Download Kokoro model" once.');
  }
  const res = await kokoroCall({
    type: 'synthesize',
    text: String(text),
    voice: voice || KOKORO_DEFAULT_VOICE,
    speed: Number(speed) || 1,
  }, KOKORO_SYNTH_TIMEOUT_MS);
  kokoroArmIdleRelease();
  return res;
}

// Downloaded-check without loading the model: transformers.js caches fetched
// files in Cache Storage under 'transformers-cache'. Matching on the model id
// keeps this robust against URL-shape changes. null = cannot determine
// (Cache Storage unavailable), so the popup never lies.
async function kokoroCacheHasModel() {
  if (typeof caches === 'undefined') return null;
  try {
    const names = await caches.keys();
    for (const n of names) {
      if (!/transformers/i.test(n)) continue;
      const keys = await caches.open(n).then((c) => c.keys());
      if (keys.some((r) => /Kokoro-82M/i.test(r.url))) return true;
    }
    return false;
  } catch (e) {
    return null;
  }
}

async function kokoroStatus() {
  const st = {
    enabled: KOKORO_ENABLED,
    phase: kokoroProgress.phase,
    pct: kokoroProgress.pct,
    detail: kokoroProgress.detail,
    workerAlive: !!kokoroWorker,
    modelLoaded: kokoroModelLoaded,
    error: kokoroLastError || '',
    downloaded: null,
  };
  if (kokoroModelLoaded) { st.downloaded = true; return st; }
  if (kokoroProgress.phase === 'downloading' || kokoroProgress.phase === 'loading') { st.downloaded = false; return st; }
  st.downloaded = await kokoroCacheHasModel();
  return st;
}

// ============================================================
// 3) Piper TTS via Native Messaging
//    Requires a registered host "sentencetts_piper" on the user's
//    machine (see PIPER_SETUP.md). The host runs the `piper` binary,
//    returns base64 WAV. Offline neural, any installed Piper voice
//    incl. en-IN models if downloaded.
// ============================================================

const PIPER_HOST = 'sentencetts_piper';

// Piper is expensive: the native host spawns a fresh `piper` process (loading
// the model into RAM) per synthesize command, and content.js prefetches several
// sentences ahead. Without a gate, all those requests pile up — content.js can
// already be fetching a new sentence while prefetched ones are still in flight —
// and the host serially reloads the model for each queued request while holding
// every returned WAV in memory until delivered. Serialize all Piper synthesis
// through one FIFO chain so at most ONE model load + one WAV buffer is in flight
// at a time, delivering results one-at-a-time instead of stacking them up.
let piperQueue = Promise.resolve();
// Monotonic cancel watermark. When content jumps away (skip / jump / click-to-
// jump), it sends ttsr-piper-cancel which bumps this. Each enqueued synthesize
// snapshots the watermark at enqueue time; by the time its turn comes, if the
// watermark moved, the sentence was superseded — drop it without loading the
// model or spawning the piper process / returning a WAV nobody will play. This
// is the "queued work cancellation" half of the RAM-crash fix: the single-flight
// FIFO already serialized Piper work, but it still RAN stale prefetches for
// superseded sentences; now those are thrown away so they can't stack model
// loads and WAV buffers in memory.
let piperWatermark = 0;
function piperCancel() {
  piperWatermark += 1;
  // NOTE — deliberately no host message here. runtime.sendNativeMessage is
  // one-shot: every call spawns a FRESH host process that exits after one
  // reply, so there is no persistent host to interrupt and a 'shutdown' here
  // would just spawn a useless second host on every skip. The watermark drop
  // above is the real mechanism (queued work never runs); an already-running
  // synthesis finishes unobserved and its result is discarded by the
  // watermark/gen guards. Residual waste is bounded to one synthesis.
}
function piperRetryableError(err) {
  // A timed-out attempt's native piper process may STILL be running (the
  // browser only reaps the host after it replies). Retrying immediately would
  // stack a second concurrent model load — the exact pile-up the FIFO exists
  // to prevent. So timeouts are NOT retried here; content.js's sentence-level
  // retry (~400ms later, by which time the orphan has usually finished) is
  // the fallback for those. All other errors retry once as before.
  return !/host timeout|timed out/i.test(String((err && err.message) || err));
}
function piperEnqueue(task) {
  const mark = piperWatermark;
  function guarded() {
    if (mark !== piperWatermark) return { stale: true };
    return task();
  }
  const run = piperQueue.then(guarded, guarded);
  piperQueue = run.catch(() => {}); // never let one failure poison the chain
  return run;
}

function piperSend(message, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error('Piper host timeout'));
    }, timeoutMs ?? 10000); // default 10s for non-synthesis commands (list)

    function cleanup() {
      clearTimeout(timer);
    }

    try {
      const p = api.runtime.sendNativeMessage(PIPER_HOST, message);
      if (p && typeof p.then === 'function') {
        p.then(
          (resp) => { if (!settled) { cleanup(); settle(resp); } },
          (err) => { if (!settled) { cleanup(); settleErr(err); } }
        );
      } else {
        api.runtime.sendNativeMessage(PIPER_HOST, message, (resp) => {
          if (settled) return;
          cleanup();
          if (api.runtime.lastError || !resp) {
            settleErr(new Error((api.runtime.lastError && api.runtime.lastError.message) || 'Piper host not reachable'));
          } else {
            settle(resp);
          }
        });
      }
    } catch (e) {
      if (!settled) {
        cleanup();
        settleErr(new Error('Piper host not reachable: ' + (e && e.message)));
      }
    }

    function settle(val) { settled = true; cleanup(); resolve(val); }
    function settleErr(err) { settled = true; cleanup(); reject(err); }
  });
}

async function piperListModels() {
  const resp = await piperSend({ cmd: 'list' });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'Piper list failed');
  return resp.models || [];
}

async function piperSynthesizeChunk(text, model, lengthScale, noiseScale) {
  const timeoutMs = piperTimeoutMs(text.length, lengthScale);

  async function attempt() {
    const resp = await piperSend({
      cmd: 'synthesize',
      text,
      model: model || '',
      length_scale: lengthScale,
      noise_scale: noiseScale,
    }, timeoutMs);
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'Piper synthesis failed');
    if (!resp.audio_base64) throw new Error('Piper returned no audio');
    return base64ToArrayBuffer(resp.audio_base64);
  }

  // One retry with a short backoff for every failure EXCEPT timeouts — see
  // piperRetryableError: a timed-out piper process may still be running, and
  // an immediate retry would stack a second concurrent model load. content.js
  // re-tries the sentence once too, so the total stays bounded and the
  // circuit breaker still stops a permanently-dead host.
  try {
    return await attempt();
  } catch (e) {
    if (!piperRetryableError(e)) throw e;
    await sleep(500);
    return await attempt();
  }
}

async function piperSynthesize(text, model, lengthScale, noiseScale) {
  // A sentence with no pronounceable characters (an ellipsis-only line, a
  // scene separator) makes piper emit a zero-sample WAV, which Python's wave
  // module then crashes closing (_ensure_header_written → exit code 1). There
  // is nothing to say, so return no chunks instead of failing.
  if (!text || !/[\p{L}\p{N}]/u.test(String(text))) return [];
  // Long text used to be hard-truncated at 2000 chars (dropping the tail).
  // Now every engine chunks long text the same way (item 8): synthesize
  // each chunk separately and return one WAV ArrayBuffer per chunk, played
  // back-to-back by the content script. Removes the silent truncation.
  const chunks = chunkText(text, 2000);
  const parts = [];
  for (const c of chunks) {
    parts.push(await piperSynthesizeChunk(c, model, lengthScale, noiseScale));
  }
  return parts;
}

// ============================================================
// 4) PDF fetch (for the bundled PDF reader page in pdfviewer.html)
//    The PDF viewer is an extension page, so it fetches the PDF here
//    rather than from the web context — host_permissions <all_urls>
//    (plus file:///*) let us read http(s), file and data PDFs. blob:
//    URLs only exist in the page that created them, so those are relayed
//    to that tab's content script (ttsr-pdf-fetch-local in content.js).
// ============================================================

async function fetchPdfRoute(url, originTabId) {
  const u = String(url || '');
  if (/^blob:/i.test(u)) {
    if (!originTabId) {
      throw new Error('Blob PDFs can\'t be fetched from the extension — open the PDF from its web URL.');
    }
    const res = await api.tabs.sendMessage(originTabId, { type: 'ttsr-pdf-fetch-local', url: u });
    if (!res || !res.ok || !res.data) {
      throw new Error((res && res.error) || 'could not read this blob PDF from the page');
    }
    return res.data;
  }
  let resp;
  try {
    resp = await fetch(u, { credentials: 'include' });
  } catch (e) {
if (/^file:/i.test(u)) {
        const isAllowed = await isAllowedFileScheme();
        if (!isAllowed) {
          throw new Error(
            'Local file access is OFF for this extension. ' +
            (IS_FIREFOX
              ? 'Go to about:addons → SentenceTTS Reader → Permissions and enable "Allow access to file URLs". '
              : 'Go to the extension\'s details page (chrome://extensions) and enable "Allow access to file URLs". ') +
            'Then press Read again.'
          );
        }
        // Grant present but the direct fetch still failed — the reader falls
        // back to a file picker, so point the user at it.
        throw new Error('Local file blocked in this browser — use "Choose the PDF file…" below.');
      }
    throw new Error('Could not fetch the PDF: ' + String((e && e.message) || e));
  }
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' fetching PDF');
  return resp.arrayBuffer();
}

// ============================================================
// message router
// ============================================================

// Offscreen bridge (Chrome build): the offscreen document posts every worker
// event here, plus a readiness ping until we ack it. Firefox never sees these
// types (it has no offscreen document).
api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === '__kokoroFromOffscreen' && msg.message) {
    handleKokoroMessage(msg.message);
    return false;
  }
  // Do NOT ack the readiness ping here: this listener registers at SW startup,
  // so acking would make offscreen.js stop pinging long before
  // kokoroSpawnOffscreen() adds its own ready-handler (right after
  // createDocument resolves) — the 15s readiness timeout then fires with the
  // document perfectly healthy. Only the dedicated waiting handler acks.
  if (msg.type === '__kokoroOffscreenReady') return false;
  return false;
});

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  // Internal Kokoro bridge traffic must NEVER reach the switch's default arm
  // (which would sendResponse on it): '__kokoroFromOffscreen' is handled by
  // the dedicated listener above, and a response to a readiness ping tells
  // offscreen.js to STOP pinging — the default arm answering the very first
  // ping exactly reproduced the "document did not signal readiness" timeout
  // (pings stopped before kokoroSpawnOffscreen's handler was registered).
  if (msg.type === '__kokoroFromOffscreen' || msg.type === '__kokoroOffscreenReady' ||
      msg.type === '__kokoroToOffscreen') return false;

  switch (msg.type) {
    case 'ttsr-gcloud-synthesize':
      gcloudSynthesize(msg.text, msg.voice, msg.rate, msg.pitch)
        .then((buf) => sendResponse({ ok: true, audio: buf }))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true;

    case 'ttsr-gfree-synthesize':
      gfreeSynthesize(msg.text, msg.lang)
        .then((buf) => sendResponse({ ok: true, audio: buf }))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true;

    case 'ttsr-piper-list-models':
      piperListModels()
        .then((models) => sendResponse({ ok: true, models }))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err), models: [] }));
      return true;

    case 'ttsr-piper-shutdown':
      // Fire-and-forget from content on stop/end: ask the native host to exit
      // so piper's RAM is freed now rather than on the idle timeout. Best
      // effort — if the host is already gone that's fine.
      piperSend({ cmd: 'shutdown' }, 2000).catch(() => {});
      sendResponse({ ok: true });
      return true;

    case 'ttsr-piper-cancel':
      // Fire-and-forget from content whenever the current sentence jumps
      // (skip / jump / click-to-jump). Drops queued-but-unstarted Piper
      // synthesis for superseded sentences and frees the host's RAM. Content
      // has already bumped its own `gen`, so the stale results it does consume
      // are discarded there; this message just stops the background from doing
      // that wasted work in the first place.
      piperCancel();
      sendResponse({ ok: true });
      return true;

    case 'ttsr-kokoro-synthesize':
      if (!KOKORO_ENABLED) { sendResponse({ ok: false, error: kokoroNotReady().message }); return true; }
      // Run through the single-flight queue — same shape as Piper's
      // piperEnqueue: one model session, one job at a time; a job whose
      // watermark moved while queued resolves `{stale}` and is dropped
      // without touching the worker.
      kokoroEnqueue(() => kokoroSynthesize(msg.text, msg.voice, msg.speed))
        .then((bufs) => {
          if (bufs && bufs.stale) { sendResponse({ ok: false, error: 'cancelled' }); return; }
          sendResponse({ ok: true, audio: bufs });
        })
        .catch((err) => {
          const e = String((err && err.message) || err);
          console.error('[SentenceTTS][background][kokoro] synthesis failed:', e);
          console.error('[SentenceTTS][background][kokoro] text:', msg.text);
          sendResponse({ ok: false, error: e });
        });
      return true;

    case 'ttsr-kokoro-status':
      if (!KOKORO_ENABLED) { sendResponse({ ok: false, error: kokoroNotReady().message }); return true; }
      kokoroStatus()
        .then((st) => sendResponse({ ok: true, ...st }))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true;

    case 'ttsr-kokoro-download':
      if (!KOKORO_ENABLED) { sendResponse({ ok: false, error: kokoroNotReady().message }); return true; }
      // Explicit user consent from the popup. Start the load in the worker and
      // respond immediately — progress is observable via ttsr-kokoro-status
      // polling (kokoroProgress is mirrored here from worker events), so the
      // popup can close mid-download without holding a message channel open.
      kokoroLastError = '';
      kokoroEnsureHost()
        .then(() => kokoroPost({ type: 'download' }))
        .then(() => sendResponse({ ok: true, started: true }))
        .catch((e) => {
          const m = String((e && e.message) || e);
          console.error('[SentenceTTS][background][kokoro] download failed to start:', m);
          kokoroLastError = m;
          sendResponse({ ok: false, error: m });
        });
      return true;

    case 'ttsr-kokoro-shutdown':
      // Fire-and-forget from content on stop: terminate the worker so the
      // model's RAM is freed now rather than on the idle timeout. Mirrors
      // ttsr-piper-shutdown. NOT while busy: a shutdown can race an in-flight
      // Play (hiccup breaker, content reset, Stop-after-Play) and yanking the
      // worker then killed live synthesis with "Kokoro worker released" —
      // skip the release and let the idle timer reclaim the RAM instead.
      if (kokoroIsBusy()) {
        console.warn('[SentenceTTS][background][kokoro] shutdown deferred — worker busy (jobs:', kokoroPending.size, 'phase:', kokoroProgress.phase + ')');
        kokoroArmIdleRelease();
      } else {
        kokoroRelease();
      }
      sendResponse({ ok: true });
      return true;

    case 'ttsr-kokoro-cancel':
      // Fire-and-forget from content on skip/jump — drops queued-but-unstarted
      // Kokoro synthesis. Same rationale as ttsr-piper-cancel.
      kokoroCancel();
      sendResponse({ ok: true });
      return true;

    case 'ttsr-piper-synthesize':
      // Run through the single-flight queue so Piper synthesis (a fresh model
      // load per call in the native host) never stacks up — this is the main
      // lever against the "switching sentences reloads Piper and fills RAM"
      // crash. sendResponse for the message is called only when THIS queued
      // task completes. A task that was cancelled (ttsr-piper-cancel bumped the
      // watermark after enqueue) resolves `{stale}` and is dropped without
      // touching the host.
      piperEnqueue(() => piperSynthesize(msg.text, msg.model, msg.length_scale, msg.noise_scale))
        .then((buf) => {
          if (buf && buf.stale) { sendResponse({ ok: false, error: 'cancelled' }); return; }
          sendResponse({ ok: true, audio: buf });
        })
        .catch((err) => {
          const e = String((err && err.message) || err);
          // Log the full Piper error (verbatim stderr/traceback from the host)
          // to the background console so it can be copied and reported.
          console.error('[SentenceTTS][background][piper] synthesis failed:', e);
          console.error('[SentenceTTS][background][piper] text:', msg.text);
          sendResponse({ ok: false, error: e });
        });
      return true;

    case 'ttsr-gcloud-ping':
      getCloudKey()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true;

    case 'ttsr-gcloud-list-voices':
      gcloudListVoices()
        .then((voices) => sendResponse({ ok: true, voices }))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err), voices: [] }));
      return true;

    case 'ttsr-pdf-fetch':
      fetchPdfRoute(msg.url, msg.originTabId)
        .then((buf) => sendResponse({ ok: true, data: buf }))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true;

    default:
      return false;
  }
});
