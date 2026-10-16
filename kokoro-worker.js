// Kokoro TTS inference worker (module worker, owned by background.js).
//
// Runs the Kokoro-82M v1.0 ONNX model in-browser via transformers.js
// (vendored as vendor/kokoro/kokoro.web.js). Never touches the page: the
// background spawns this worker, feeds it sentences, and forwards the
// resulting WAV ArrayBuffers to the content script in the same
// ArrayBuffer[] chunk shape the other audio engines use.
//
// Responsibilities here, and nothing else:
//   - lazy model load: download-on-first-use from huggingface.co (explicit
//     user consent happens in the popup; the model is ~88 MB int8) with
//     progress reporting, cached persistently by transformers.js in Cache
//     Storage so it happens exactly once per device
//   - single-job synthesis (the background serializes anyway — one FIFO,
//     one watermark — mirroring the Piper single-flight discipline)
//   - between-chunk cancellation: a 'cancel' note from the background
//     abandons the running job at the next chunk boundary (skip / jump /
//     click-to-jump), so the next real job never queues behind dead work
//   - WAV encoding (24 kHz mono PCM16) so background/content never see
//     raw Float32 tensors
//
// RAM discipline: the background terminates this worker on stop / idle
// timeout / engine switch, which frees the model + WASM heap immediately.
// Loading again costs an ORT session init (tens of seconds on slow
// machines) — that is the accepted trade-off, same as Piper's shutdown.

import { KokoroTTS, env } from './vendor/kokoro/kokoro.web.js';

// The bundle defaults to fetching the ORT wasm binary from jsdelivr (remote
// code — forbidden). Point it at the extension-local vendored copies.
env.wasmPaths = new URL('./vendor/kokoro/', self.location.href).href;

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_VOICE = 'af_heart';
const FALLBACK_SAMPLE_RATE = 24000;
// Kokoro handles ~510 phonemes per pass (~1000 English chars). Sentences from
// content.js are usually far below this; 800 is a conservative per-call cap.
const MAX_CHARS = 800;
const SPEED_MIN = 0.5;
const SPEED_MAX = 2;

let tts = null;              // loaded KokoroTTS instance
let loadPromise = null;      // in-flight load (download + session init)
let progress = { phase: 'idle', pct: 0, detail: '' };
let cancelRequested = false; // set by a 'cancel' note; consumed between chunks

function reportProgress(phase, pct, detail) {
  progress = { phase, pct, detail: detail || '' };
  self.postMessage({ type: 'progress', phase: progress.phase, pct: progress.pct, detail: progress.detail });
}

async function ensureModel() {
  if (tts) return tts;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    reportProgress('loading', 0, 'loading model…');
    const inst = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: 'q8', // 88 MB int8 quantized — verified artifact (see KOKORO_SPIKE.md)
      progress_callback: (p) => {
        if (p && p.status === 'progress' && p.total) {
          reportProgress('downloading', Math.min(100, Math.round((p.loaded / p.total) * 100)), p.file || '');
        }
      },
    });
    tts = inst;
    reportProgress('loading', 100, 'initializing WASM…');
    // Warm-up: pulls the default voice file (~522 KB) and pays the WASM
    // compile/JIT cost once, so the first real sentence isn't a 30s+ stall.
    await inst.generate('Ready.', { voice: DEFAULT_VOICE, speed: 1 });
    reportProgress('ready', 100, '');
    return inst;
  })().catch((e) => {
    loadPromise = null;
    tts = null;
    reportProgress('idle', 0, '');
    throw e;
  });
  return loadPromise;
}

// Sentence-boundary split capped at MAX_CHARS. Falls back to word and then
// hard splits for pathological overlong sentences.
function splitForKokoro(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  if (t.length <= MAX_CHARS) return [t];
  const parts = [];
  let buf = '';
  const pieces = t.match(/[^.!?。！？।॥؟…]+[.!?。！？।॥؟…]+["'”’)\]」』]*\s*|[^.!?。！？।॥؟…]+$/g) || [t];
  for (const piece of pieces) {
    if (buf && (buf + piece).length > MAX_CHARS) { parts.push(buf.trim()); buf = piece; }
    else { buf = (buf ? buf + ' ' : '') + piece; }
    while (buf.length > MAX_CHARS) {
      let cut = buf.lastIndexOf(' ', MAX_CHARS);
      if (cut < MAX_CHARS * 0.5) cut = MAX_CHARS;
      parts.push(buf.slice(0, cut).trim());
      buf = buf.slice(cut).trim();
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.filter(Boolean);
}

// 44-byte RIFF header + little-endian PCM16 mono.
function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);          // block align
  view.setUint16(34, 16, true);         // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    let s = samples[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buf;
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  // Skip/jump/click-to-jump in the content script: the background bumped
  // its watermark (dropping every queued job) and posted this note to stop
  // the RUNNING job as well. Inference can't be aborted mid-pass, but the
  // loop below checks between chunks, so an abandoned multi-chunk sentence
  // stops after the chunk in flight. The flag is reset at the start of
  // every new job, so a cancel that lands while idle (or after the final
  // chunk) can never kill the next legitimate synthesis.
  if (msg.type === 'cancel') {
    cancelRequested = true;
    return;
  }
  try {
    if (msg.type === 'synthesize') {
      cancelRequested = false;
      const inst = await ensureModel();
      const chunks = splitForKokoro(msg.text);
      const out = [];
      for (let i = 0; i < chunks.length; i++) {
        if (cancelRequested) {
          // Not an error — the caller moved on. background.js resolves this
          // as a sentinel rejection that content's catch ignores silently.
          self.postMessage({ type: 'cancelled', id: msg.id });
          return;
        }
        const audio = await inst.generate(chunks[i], {
          voice: msg.voice || DEFAULT_VOICE,
          speed: Math.min(SPEED_MAX, Math.max(SPEED_MIN, Number(msg.speed) || 1)),
        });
        const f32 = audio && audio.audio instanceof Float32Array ? audio.audio : audio;
        if (!(f32 instanceof Float32Array) || f32.length === 0) {
          throw new Error('Kokoro produced no audio for chunk ' + (i + 1) + '/' + chunks.length);
        }
        const wav = encodeWav(f32, (audio && audio.sampling_rate) || FALLBACK_SAMPLE_RATE);
        out.push(wav);
        self.postMessage({ type: 'chunk-progress', id: msg.id, chunk: i + 1, total: chunks.length });
      }
      // Transfer (not clone) the WAV buffers back to the background.
      self.postMessage({ type: 'synthesized', id: msg.id, audio: out }, out);
    } else if (msg.type === 'download') {
      // Explicit user action from the popup. from_pretrained downloads into
      // Cache Storage (persistent); a second call loads from cache.
      await ensureModel();
      self.postMessage({ type: 'download-done' });
    } else if (msg.type === 'status') {
      self.postMessage({ type: 'status-reply', loaded: !!tts, phase: progress.phase, pct: progress.pct, detail: progress.detail });
    }
  } catch (e) {
    const error = String((e && e.message) || e);
    self.postMessage(
      msg.type === 'download'
        ? { type: 'download-error', error }
        : { type: 'synth-error', id: msg.id, error },
    );
  }
};
