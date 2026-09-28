// Offscreen bridge for the Kokoro worker (Chrome build only — see
// offscreen.html). Spawns the real module worker and proxies both directions
// over runtime messaging:
//   background -> here:  { type: '__kokoroToOffscreen', payload }  (postMessage)
//   here -> background:  { type: '__kokoroFromOffscreen', message } (events)
// ArrayBuffer payloads do not survive runtime messaging (JSON-serialized), so
// synthesis audio is base64-encoded here and decoded in background.js via its
// existing base64ToArrayBuffer helper.
'use strict';
// Everything below is defensive: the offscreen document is the ONLY place the
// Kokoro worker can live in Chrome MV3, so any failure here must reach the
// background (and therefore the popup) instead of dying silently — a script
// that dies at the Worker constructor previously left the background waiting
// on a readiness ping that would never come.

function reportToBackground(message) {
  try {
    chrome.runtime.sendMessage({ type: '__kokoroFromOffscreen', message })
      .catch(() => {});
  } catch (e) {}
}

// Uncaught top-level errors (e.g. a throwing Worker constructor) must not be
// silent: report, then keep pinging readiness OFF so the background fails
// fast with the real reason instead of its 15s timeout.
window.onerror = function (msg) {
  reportToBackground({ type: '__kokoroError', error: 'offscreen: ' + String(msg).slice(0, 300) });
  return false;
};

let worker = null;
try {
  worker = new Worker(chrome.runtime.getURL('kokoro-worker.js'), { type: 'module' });
} catch (e) {
  reportToBackground({ type: '__kokoroError',
    error: 'offscreen: Worker constructor threw: ' + String((e && e.message) || e) });
}

if (worker) {
  worker.onmessage = (ev) => {
    const m = ev.data || {};
    const out = { type: '__kokoroFromOffscreen', message: m };
    if (m.type === 'synthesized' && Array.isArray(m.audio)) {
      out.message.audioB64 = m.audio.map(arrayBufferToBase64);
      delete out.message.audio;
    }
    try { chrome.runtime.sendMessage(out).catch(() => {}); } catch (e) {}
  };
  worker.onerror = (ev) => {
    const e = 'Kokoro worker failed to start: ' + ((ev && ev.message) || 'unknown error');
    try { chrome.runtime.sendMessage({ type: '__kokoroFromOffscreen', message: { type: '__kokoroError', error: e } }).catch(() => {}); } catch (err) {}
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== '__kokoroToOffscreen') return false;
  if (msg.payload && msg.payload.type === '__probe') {
    // Diagnostics: proves the listener is alive without touching the worker.
    sendResponse({ ok: true, hasWorker: !!worker });
    return false;
  }
  if (!worker) {
    sendResponse({ ok: false, error: 'offscreen: worker unavailable' });
    return false;
  }
  try { worker.postMessage(msg.payload || {}); sendResponse({ ok: true }); }
  catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
  return false;
});

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// Readiness ping: keep announcing until the background acks. This closes the
// race where background.js adds its one-shot ready-listener only AFTER
// createDocument resolves (the document may already be evaluating by then).
let readyAcked = false;
let readyTimer = null;
function pingReady() {
  if (readyAcked) { if (readyTimer) { clearInterval(readyTimer); readyTimer = null; } return; }
  try {
    chrome.runtime.sendMessage({ type: '__kokoroOffscreenReady' })
      .then(() => { readyAcked = true; }, () => {});
  } catch (e) {}
}
pingReady();
readyTimer = setInterval(pingReady, 250);
