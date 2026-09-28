# SentenceTTS Reader v2.3.4

Reads any webpage — or any PDF — aloud with live sentence highlighting. One
sentence plays at a time; the current sentence is highlighted and auto-scrolled
into view. Five TTS engines are available and you switch between them from the
popup — the intent is that at least one always works with zero setup, and a much
better voice is one settings screen away.

> Firefox and Chrome/Edge. Manifest V3, `strict_min_version` 140.0 (Firefox,
> `gecko_android` 142.0) / `minimum_chrome_version` 119 (Chrome). The two builds
> share every source file; only the manifest, the Piper native host manifest, and
> **where the Kokoro worker is allowed to run** differ — Chrome MV3 service
> workers cannot construct a `Worker`, so there Kokoro runs inside an offscreen
> document (`offscreen.js`). See `AGENT.md` and `build-source/BUILD.md` → Chrome
> Build.

## The five engines

| Engine | What it is | Setup | Speed/pitch control | Best for |
|---|---|---|---|---|
| **Google Free** (`gfree`, default) | The unofficial `translate.google.com/translate_tts` endpoint | None — no key | None | Instant read, no account. Note: the endpoint accepts `tl=en-IN` but returns audio byte-identical to `tl=en` — there is no distinct Indian-English voice (verified). Use `gcloud` for real en-IN |
| **Google Cloud** (`gcloud`) | Official Google Cloud Text-to-Speech REST API | Paste an API key (popup → Advanced) | Yes (rate + pitch) | Best neural en-IN voices; the "correct" paid option |
| **Piper** (`piper`) | Offline neural TTS via a local Piper binary + native messaging host | Install `piper` + a voice model + register the host (see `PIPER_SETUP.md`) | Yes (rate) | Fully offline, private, no rate limits — desktop only (native messaging does not exist on Android) |
| **Kokoro** (`kokoro`) | Offline neural TTS (Kokoro-82M, `q8`) running **inside the extension** — vendored `kokoro-js` + local ONNX Runtime WASM. No binary, no host, no key, no telemetry | Opt-in: popup → engine Kokoro → **Download** once (~88 MB, cached for future versions); until then the engine says "not ready" and stays silent | Rate yes (drives the model's tempo, 0.5–2×); pitch n/a | A neural voice with zero install, and the only offline-neural option on Firefox for Android. Cost: ~1 s of synthesis per second of speech on modest CPUs, and a cold model load measured at ~116 s on a 1.2 GHz i3 — 2× playback gaps on weak hardware |
| **System** (`system`) | The browser's own `speechSynthesis` voices | None (needs espeak-ng/speech-dispatcher on Linux for non-robotic output) | Yes (rate + pitch) | Zero-setup fallback; also the only engine that never touches the background script |

The architecture (two scripts, clean split) is what makes all five share one
playback + highlighting layer:

```
content.js (injected into the page)             background.js (extension page)
─────────────────────────────────────           ─────────────────────────────
 finds the article/chapter text
 wraps each sentence in a <span>
 highlight + auto-scroll the current sentence
 picks engine, sends {text, voice, speed}  ──►  gcloud   ──►  Google Cloud API
                                                gfree    ──►  translate_tts
                                                piper    ──►  native host → piper
                                                kokoro   ──►  kokoro-worker.js
 plays the returned audio chunks       ◄──  returns Array of ArrayBuffers (one per chunk)
 via <audio> elements chained on 'ended'      (Firefox: a module worker owned by
                                               background.js; Chrome: the same
                                               worker inside an offscreen document,
                                               because MV3 service workers cannot
                                               create one — audio comes back base64)

 system engine: speechSynthesis runs entirely in content.js — never hits background.js
```

Three things are worth calling out about that design:

- **One sentence per utterance / per audio chain.** The unit of playback is a
  single sentence, not a paragraph. This is what makes pause/resume and
  click-to-jump reliable.
- **Long sentences are chunked per engine, played back-to-back (no byte
  stitching).** `translate_tts` caps near 200 chars/request and Piper is memory
  bound; rather than concatenate MP3/WAV bytes (a "usually works, sometimes
  clicks at the seam" hack) or silently truncate, every audio engine splits long
  text with the same word-boundary `chunkText` splitter, synthesizes each chunk
  as its own request, and the content script plays the resulting chunks as
  separate `<audio>` elements chained via `ended` — the same pattern as
  sentence-to-sentence playback, one level more granular. The next chunk's
  synthesis is fired before the current one finishes.
- **Audio engines use `<audio>` elements, not `speechSynthesis`, for
  pause/resume.** `HTMLAudioElement.pause()`/`.play()` don't have the platform
  quirks that make `speechSynthesis.pause()`/`.resume()` flaky. (The System
  engine can't escape that entirely — see below.)

## Controls

From the popup: **Play/Pause, Stop, Next, Prev**, plus rate/pitch sliders (where
the engine supports them), an engine picker, and a searchable voice picker
(per-engine voice source). Firefox closes ephemeral popups the moment the page
regains focus, so once a read starts a small **player is pinned to the page
bottom** (⏮ ⏸/▶ ⏭ ■ + sentence counter) that keeps working regardless of the
popup. On the page: **click any sentence to jump to it**.

Settings (engine, voice, speed, pitch, and your Google Cloud key) persist across
popup close/reopen via `storage.local`.

## Reading PDFs

Firefox won't let extensions inject scripts into its built-in PDF viewer, so the
extension ships a small reader instead. Open any web-hosted `.pdf` tab and the
popup shows **Read this PDF**; the bundled reader extracts the text, renders a
live page thumbnail, and reads it with the same highlighting (the current page
flips as you cross page boundaries). Embedded PDFs are detected too.

Local `file://` PDFs: enable file access for the extension — Firefox: `about:addons`
→ Permissions ("Allow access to file URLs"; Firefox 153+ calls it "Access local
files on your computer" and keeps it **off by default even with `<all_urls>`** —
re-check the toggle if reading stops working after upgrading). Chrome: the
extension's Details page → *Allow access to file URLs* (Chrome lets the extension
fetch `file://` PDFs when granted). If the direct fetch is still refused, the
reader automatically switches to a file picker ("Choose the PDF file…") or
drag-and-drop — that path needs **no** permissions, so a local PDF always works
with one extra click.

## Auto-refresh resilience

Playback state is saved between reloads: if a site reloads itself mid-read (e.g.
novelbuddy), the reader resumes right where it left off. If a tab stays cached
for hours, the saved position is discarded and the content is re-split fresh, so
you never read stale text against a dead page.

## Pause/resume reliability (the thing this project actually fixes)

The original bug was that `speechSynthesis.pause()`/`.resume()` is flaky on Linux,
producing hangs and silent failures. The fix is different per engine family:

- **gfree / gcloud / piper / kokoro (audio engines):** pause calls
  `HTMLAudioElement.pause()` on the current chunk's element; resume calls
  `.play()` on that **same** element, so playback continues from the exact paused
  position. Reliably. Pause also stops *scheduling* more prefetch; already-queued
  synthesis in the background is dropped when you **move** (Next/Prev or a jump),
  not while merely paused.
- **System engine:** can't use `speechSynthesis.pause()`/`.resume()` (that's the
  bug). Instead, pause cancels the current utterance and remembers the sentence
  index; resume starts a **new** utterance for that same sentence from the
  beginning. This trades exact mid-sentence resume position for actual
  reliability. Because each sentence is short (one utterance), restarting a
  sentence is a minor UX cost, not a jarring one — the correct trade given native
  pause/resume is what's flaky.

## Reliability

- **gfree retry.** `translate_tts` is an unofficial endpoint and rate-limits
  (HTTP 429). Each synthesis chunk gets one retry with a short backoff before
  giving up.
- **Silent-sentence skip.** Punctuation-only "sentences" (an ellipsis-only
  line, a scene separator) have nothing to pronounce — Piper produces zero
  audio for them and its WAV writer crashes, so they now skip instantly without
  synthesis on every engine.
- **System voice quality.** The voice picker ranks natural/neural voices
  (Edge "Natural", Chrome "Google …", Apple "Premium"/"Enhanced") first with a
  ★, sinks robotic ones (eSpeak, macOS "Compact"), and auto-selects the
  best-sounding voice on first use instead of the OS default.
- **Continuous engine-aware prefetch.** A steady prefetch loop keeps upcoming
  sentences synthesized and cached ahead of playback — the synthesis pipeline
  stays busy instead of idling between sentences, so 2x playback no longer
  drains a shallow 2-ahead buffer and stalls every few sentences waiting for the
  next. `gfree` prefetches only 2 ahead (it rate-limits); `gcloud` and `piper`
  prefetch 6 ahead. Piper can prefetch deep now because single-flight +
  queued-work cancellation keep its model load serialized (one at a time) and
  RAM bounded — the old depth-2 limit was for the *unserialized* model-load
  stacking that crashed Firefox, which is gone.
- **Single-flight Piper synthesis with queued-work cancellation.** All Piper
  synthesis runs through a FIFO in the background so at most one model load +
  one WAV buffer is in flight at a time. When you skip/jump (including
  click-to-jump), queued-but-unstarted Piper work for superseded sentences is
  dropped rather than run-and-discarded — this is what keeps rapid sentence
  switching from piling up `piper` processes and crashing the browser with RAM
  exhaustion.
- **Visible failure indicator.** The popup is usually closed while you're
  actually reading, so a failed-to-synthesize sentence would otherwise look like
  the reader silently skipping content. When synthesis fails (after retries), a
  small status pill appears on the page (`⚠ sentence N skipped — synthesis
  failed`) and reading continues past the hiccup. It auto-hides after a few
  seconds. If synthesis fails repeatedly, reading stops cleanly rather than
  hammering the endpoint.
- **Scroll safety.** Highlighting uses instant, on-demand scrolling that briefly
  overrides the page's CSS `scroll-behavior`. (Some sites — novelbuddy sets
  `html { scroll-behavior: smooth }` — compound smooth-scroll animations on very
  long chapters and can freeze the tab; longer reads would hang the browser.)

## Install (temporary, for testing)

**Firefox:** `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** →
select `manifest.json`.

**Chrome/Edge:** `chrome://extensions` → enable *Developer mode* → **Load
unpacked** → select `chrome-build/` (built with `node build-source/build-chrome.js`).
Piper on Chrome needs its native host registered before launch —
`chrome-build/install-piper-host.sh` (see `PIPER_SETUP.md` → Chrome section).

Open a page with readable text, click the extension icon, hit **Play**.

Firefox temporary loads reset on browser restart — fine for testing. For a
permanent, signed Firefox build, submit unlisted to
[AMO](https://addons.mozilla.org/developers/) (the source package lives in
`build-source/` — see `build-source/BUILD.md`). Chrome load-unpacked persists
until you remove the extension.

## Debugging

Two consoles, and it matters which one you look at:

- **Page DevTools** (F12): shows `content.js` — sentence detection, highlighting,
  playback, and any CSP/violation warnings on the host page. The PDF reader page
  runs content.js too, so its transcript/highlighting also shows here.
- **Background inspector:** `about:debugging` → **Inspect** next to the
  extension → Console (Firefox) / `chrome://extensions` → **Inspect views:
  service worker** (Chrome). This is where gcloud/gfree network errors, Piper
  native-messaging errors, and Kokoro's side of the worker bridge show up,
  separately from the page.
- **Kokoro worker (Firefox) / offscreen document (Chrome):** `about:debugging` →
  **Inspect** next to the extension's Kokoro worker entry. On Chrome, inspecting
  the *service worker* is what makes a hidden offscreen document attachable —
  without that attach, inference errors can look like silence. If the engine
  reports "did not signal readiness", the document was created but never
  reported back.
- **PDF reader page DevTools:** open `pdfviewer.html` in a tab and F12 — this is
  where pdf.js extraction, `ttsr-pdf-fetch`, and viewer/render errors appear.

For `gcloud` failures, check the Network tab in the background inspector for the
`texttospeech.googleapis.com` call. For `gfree`, repeated 429s mean slow down or
switch engine. For `piper`, "Piper host not reachable" means the native host
isn't registered — see `PIPER_SETUP.md`.

## Choosing an engine (practical notes)

- **Just want it to work right now?** Google Free (`gfree`). No setup, default
  English voice. Pro: instant, no key, no install. Con: unofficial endpoint that
  rate-limits, one accent per language, no speed/pitch control. The `tl=en-IN` flag
  is accepted but returns the same audio as `tl=en` (byte-identical, verified across
  two sentences), so gfree has **no** distinct Indian-English voice — use `gcloud`.
- **Want the best Indian English neural voice and don't mind a key?** Google
  Cloud (`gcloud`). Paste a key in the popup's Advanced section; it's tested on
  save. Pro: official, best neural en-IN, full rate/pitch. Con: needs a Google
  Cloud account + API key (billed).
- **Want offline / private / no rate limits?** Piper (`piper`). Pro: local neural,
  no network, no limits, full quality on desktop-class CPUs. Con: install the
  `piper` binary + a voice model + register the native messaging host (see
  `PIPER_SETUP.md`) — the most setup of the five, and desktop-only.
- **Want offline neural with nothing installed?** Kokoro (`kokoro`). Pro: a real
  neural voice with no binary, no host, no API key, no network after the one-time
  88 MB model download; the only offline-neural option on Firefox for Android.
  Con: synthesis runs on CPU in the browser — measured RTF ≈ 0.9–1.0 on a 1.2 GHz
  i3 (≈1 s of work per second of speech), so first-audio latency after pressing
  Play includes a cold model load, and 2× playback gaps on weak hardware. Opt-in:
  it never downloads anything until you press Download in the popup.
- **Fallback when nothing else is configured?** System (`system`). Pro: zero
  setup. Con: on Linux routes through speech-dispatcher → espeak-ng unless you
  install better voices; sounds robotic; uses the cancel-and-restart-sentence
  pause pattern because native pause/resume is the flaky thing this project
  replaces.

## Known limitations

- Sentence splitting is punctuation-based — imperfect on heavy abbreviations,
  solid on prose like novel chapters.
- Paragraphs with inline formatting (bold/links mid-sentence) get flattened to
  plain text when split into sentence spans.
- Content detection is a heuristic (`article`/`main`/`[class*="content"]`… scored
  by text density and paragraph count); flag a site where it grabs the wrong
  region and the scoring can be tuned.
- `gfree` has no speed/pitch control (the endpoint doesn't accept those); the
  popup shows `n/a` for them when that engine is selected. Kokoro supports rate
  but not pitch (the help line in the popup says so; the pitch readout is still
  shown as a number — known cosmetic bug).
- Kokoro's audio quality is fine; its **speed is the device-dependent part**. If
  synthesis can't keep up, you hear gaps at high playback rates — pick a lower
  rate, or `piper`/`gcloud`. The 88 MB model download has no resume-across-
  interruption path yet, so a dropped connection means starting the download over.
- SPA pages are handled (a page-world history patch installed by the browser
  as a MAIN-world content script — `spa-main.js`, immune to site CSP — plus
  link-click capture, a URL poller, and a MutationObserver on the body, all
  feeding one debounced content check with follow-ups) — chapter navigation
  on sites like NovelBuddy is detected and playback recovers if possible;
  otherwise reading resets and you press Play again (which always re-splits
  when the tab has navigated).

## License

MIT. The Piper native messaging host (`piper-host/piper_host.py`) is the bridge
to the externally-installed `piper` binary; Piper itself and Google TTS are
external services — see their respective licenses.

The Kokoro engine vendors third-party code into `vendor/kokoro/` (see its README):
**kokoro-js** (Apache-2.0) and **onnxruntime-web** WASM (MIT). The **Kokoro-82M**
model weights are Apache-2.0 as well but are **not** shipped in the extension —
the user downloads them once, into the browser's Cache Storage, after explicit
consent.
