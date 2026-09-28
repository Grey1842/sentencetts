# Build Instructions for SentenceTTS Reader

## Overview

This extension uses **no bundler or minification** for its own code. The
`background.js` file in the extension root is the exact same source as
`background-src.js` in this directory. This is intentional — AMO requires a
source-code package for any submission that includes minified/bundled code,
but since we don't minify our own source, the source package is simply a copy
of the source files.

**Third-party exception:** `vendor/kokoro/kokoro.web.js` is the official,
minified browser bundle of `kokoro-js@1.2.1` (Apache-2.0), plus the ONNX
Runtime wasm binaries it needs. For AMO source-package submissions that
include it, attach the provenance documented in `vendor/kokoro/README.md`
(npm package + version + reproduction commands). Everything we wrote
ourselves remains unminified.

The same shared files also build a **Chrome/Chromium/Edge** variant (`MV3`,
`background.service_worker`). The only differences between the two builds are
the manifest and the Piper native-messaging host manifest. See *Chrome Build*
below.

## Files in this Package

| File | Purpose |
|------|---------|
| `background-src.js` | Unminified background script — a **copy** of `../background.js`, which is the source of truth (see the sync rule under *Useful checks*) |
| `manifest.chrome.json` | Manifest template for the Chrome/Edge build (`{{SPKI_B64}}` → generated `key`) |
| `chrome-key.pem` | **Private** RSA key that fixes the Chrome extension ID (excluded from all zips) |
| `build-chrome.js` | Assembles `../chrome-build/` + `sentencetts-reader-chrome.zip` |
| `check.js` | Read-only release gate (`node check.js`): version parity, the source-parity rule below, syntax of every shipped script, and the contents of both zips (parses the archives' central directories and CRC-compares each entry to the tree) |
| `package.json` | Metadata plus the `verify` / `check` / `package` / `release` scripts that drive the checks below |
| `BUILD.md` | This file |

## Verification Steps (Run by AMO Reviewers)

AMO reviewers will verify that the submitted extension matches this source:

```bash
# 1. Check syntax validity
node -c background-src.js

# 2. Compare with submitted extension's background.js
diff background-src.js ../background.js
# Should produce no output (files are identical). If it does NOT: the copy in
# this directory was not refreshed after the last background change. Refresh it
# in THIS direction only — `cp ../background.js background-src.js`, i.e.
# `npm run sync-source`. The real background script in the repo root is the
# source of truth, and no script here copies the other way any more.

# 3. Verify no eval/Function constructor usage
grep -n "eval\|Function(" background-src.js
# Should only match in comments or string literals

# 4. Verify CSP compliance
# manifest.json must have content_security_policy.extension_pages.script-src = 'self'

# 5. Or run all of the above, plus the zip-content checks, in one command
node check.js
```

## Build Process

**There is no build process.** The extension is written in plain ES2020+ JavaScript that runs natively in Firefox's background page (MV3, `background.scripts` with module-type semantics).

If you ever add a build step (e.g., TypeScript, minification), update this document and `package.json` accordingly.

## Required Files for Submission

The submission ZIP must contain:

```
sentencetts-reader/
├── manifest.json
├── background.js          # ← identical to build-source/background-src.js
├── kokoro-worker.js       # Kokoro inference worker (module worker, ESM)
├── content.js
├── spa-main.js            # page-world SPA tripwire (manifest "world": "MAIN")
├── content.css
├── popup.html
├── popup.js
├── popup.css
├── pdfviewer.html         # bundled PDF reader page (loads a PDF, feeds it to content.js)
├── pdfviewer.js           # ESM (imports ./pdf/pdf.mjs)
├── pdf/
│   ├── pdf.mjs            # pdf.js library (unminified ESM build)
│   └── pdf.worker.mjs     # pdf.js worker (unminified ESM build)
├── vendor/
│   └── kokoro/            # Kokoro TTS runtime (see vendor/kokoro/README.md)
│       ├── kokoro.web.js  #   kokoro-js 1.2.1 official browser bundle (~2.1 MB)
│       ├── ort-wasm-simd-threaded.jsep.wasm    # onnxruntime-web 1.22.0-dev.20250409
│       ├── ort-wasm-simd-threaded.jsep.mjs     #   (emscripten loader)
│       └── README.md      #   provenance, licenses, reproduction steps
├── icons/
│   ├── icon-16.png
│   ├── icon-32.png
│   ├── icon-48.png
│   └── icon-128.png
└── build-source/          # ← THIS DIRECTORY (required by AMO)
    ├── background-src.js
    ├── package.json
    ├── check.js
    └── BUILD.md
```

## Creating the Submission ZIP

From the project root. `npm run package` runs exactly this, plus a final
`node build-source/check.js`:

```bash
rm -f sentencetts-reader.zip   # zip UPDATES an existing archive — never reuse one
zip -r sentencetts-reader.zip \
  manifest.json \
  background.js \
  kokoro-worker.js \
  content.js \
  spa-main.js \
  content.css \
  popup.html \
  popup.js \
  popup.css \
  pdfviewer.html \
  pdfviewer.js \
  pdf/ \
  vendor/ \
  icons/ \
  build-source/ \
  -x "build-source/chrome-key.pem" \
     "build-source/manifest.chrome.json" \
     "build-source/build-chrome.js"
```

**Do NOT include:**
- `README.md`
- `AGENT.md`
- `PIPER_SETUP.md`
- `KOKORO_SPIKE.md`
- The Kokoro model itself — it is **never bundled**. The 88 MB q8 model is
  downloaded once at runtime from huggingface.co after explicit user consent
  in the popup (see `vendor/kokoro/README.md`).

- `.claude/` directory
- `piper-host/` directory (native messaging host is installed separately by user)
- Chrome-only files — `offscreen.html`, `offscreen.js`, `chrome-build/`,
  `build-source/chrome-key.pem`, `build-source/manifest.chrome.json`,
  `build-source/build-chrome.js` (Firefox's MV3 background can construct a
  `Worker` and never loads the offscreen document; shipping them only confuses
  review. The private key + Chrome-specific artifacts are not part of the AMO
  source package either.)
- Any `.git/` or `node_modules/` directories

**Check the zip is actually current before submitting** — the one on disk sat at
`2.3.2` for two releases while the tree moved on. One command covers it:

```bash
node build-source/check.js     # exit 0 = safe to submit; 1 = rebuild first
```

It reads the archive's central directory and CRC-compares every entry against the
working tree, so it catches a stale artefact *and* a forbidden one, and it checks
the same invariants for the Chrome build. Spot checks by hand, if you prefer:

```bash
unzip -p sentencetts-reader.zip manifest.json | grep '"version"'   # == manifest.json
cmp <(unzip -p sentencetts-reader.zip background.js) background.js  # silent = fresh
unzip -l sentencetts-reader.zip | grep -c offscreen                # must be 0
unzip -l sentencetts-reader.zip | grep -c chrome-key.pem           # must be 0
```

`check.js` ships in this directory precisely so a reviewer can run it too — it is
read-only, has no dependencies, and touches nothing.

## AMO Submission Text — the 2.3.4 upload

Build the zip **last**, after every edit to this file: `build-source/BUILD.md`
ships *inside* the submission package, so any size or hash written here goes stale
the instant you edit it — that self-inflicted staleness is precisely how the zip
ended up two releases behind once. Verify after the final build with `ls -l` +
`sha256sum sentencetts-reader.zip` and record the numbers in `AGENT.md`, not here.

The 2026-09-28 rebuild is **27 files / 32 entries (~6.7 MB)**, CRC-clean, with
every entry byte-identical to the tree — including
`build-source/background-src.js` == `background.js` *inside* the archive, so the
reviewer's `diff` is empty. Because AMO has served
**2.1.0** since 2026-09-07, these notes are **cumulative since 2.1.0**, not a
2.3.4-only changelog. The repo has **no CHANGELOG**, so anything user-visible that
landed only in 2.2.x / 2.3.1–2.3.2 is recorded nowhere — add it from your own notes.

### Paste into "What's new"

```
New engine: Kokoro — offline neural TTS (Kokoro-82M) running entirely inside the
extension. No binary to install, no API key, no account, no telemetry. It is
opt-in: choose Kokoro in the popup, then press Download once (~88 MB, cached and
reused by later versions, clearable from browser storage).

Also in this release:
- Kokoro is the only offline neural option on Firefox for Android.
- Queue handling hardened: queued sentences are dropped when you skip ahead,
  press Stop, or switch engine, and the model's worker is released on
  stop/switch/5-minute idle so it stops holding RAM.
- Kokoro's speed control drives the model's own tempo (0.5-2x).
- Reliability fixes and automated behaviour tests added since 2.1.0.
```

### Paste into "Developer comments to reviewers"

```
First update since 2.1.0, so the size and diff are larger than a normal release.

1. Size 730,600 -> ~6.7 MB. The delta is vendor/kokoro/: a vendored copy of
   kokoro-js 1.2.1 (Apache-2.0, 2,135,146 B), the ONNX Runtime WASM build
   ort-wasm-simd-threaded.jsep.wasm (MIT, 21,596,019 B) with its .mjs loader, and
   vendor/kokoro/README.md recording provenance and licences. No code is fetched
   at runtime; everything executable ships in this package.
2. New host permission https://huggingface.co/* — used ONLY to download the 88 MB
   Kokoro-82M q8 weights (Apache-2.0), and only after the user presses Download in
   an explicit consent panel. The weights are not in this package, are never
   auto-downloaded, and nothing else contacts that host.
3. CSP gained exactly one value: 'wasm-unsafe-eval' in
   content_security_policy.extension_pages, required by the ONNX Runtime WASM
   runtime. 'self' is still the only script source; no remote code, no string eval.
4. Source = production: no bundler, minifier or transpiler. The shipped background
   script is byte-identical to the copy in this package:
     diff background.js build-source/background-src.js     # empty
5. nativeMessaging is unchanged from 2.1.0 — it belongs to the optional Piper
   engine, which talks to a `piper` binary the user installs and registers
   themselves. No host binary ships here.
6. Kokoro inference runs in a dedicated module worker (kokoro-worker.js) owned by
   the background script, never in a content script/page. The Chrome-only build
   files (offscreen.html/offscreen.js) are intentionally absent from this Firefox
   package; Firefox can construct a Worker directly.
7. Data-collection declaration is unchanged from 2.1.0: websiteContent (required),
   authenticationInfo (optional). No analytics, no telemetry, no server of ours.
```

### Before clicking Submit (Developer Hub — not part of the package)

- [ ] **License.** The published version declares **All Rights Reserved** (AMO id
  7057) while `README.md` §License and this file's §License both say **MIT**, and
  the repo contains **no license file at all**. Either set the AMO field to MIT and
  add a `LICENSE` file (then add it to the zip command above), or correct the docs.
- [ ] **Privacy policy.** `has_privacy_policy` is false while the listing declares
  required `websiteContent` collection.
- [ ] **Icon.** AMO serves its default placeholder even though `icons/` holds 16–128
  px PNGs — the listing icon is a separate Developer Hub upload.
- [ ] **Previews / homepage.** `previews: []`, `homepage: null` — add screenshots
  and the repo URL.
- [ ] Channel **listed**; compatibility Firefox 140+ / Android 142+ (unchanged, and
  it matches `manifest.json`).


## Chrome Build

The shared files (`background.js`, `content.js`, `spa-main.js`, `content.css`,
`popup.*`, `pdfviewer.*`, `pdf/`, `icons/`) and the browser-adaptive
`background.js` work in Chrome unchanged. Only the manifest differs. Build with:

```bash
node build-source/build-chrome.js
```

This:
1. Reads `build-source/chrome-key.pem` and computes the stable Chrome extension
   ID from it: **`b6ecf49b455c8c297c695d998f40d28a`** — the first 32 hex chars
   of SHA-256 over the public key's SPKI DER. The `key` field in the manifest
   bakes the public key in, so unpacked loads keep this ID across restarts and
   updates (and it is what the Piper `allowed_origins` must match).
2. Writes `chrome-build/manifest.json` (`background.service_worker`,
   CSP `worker-src 'self'` with no `blob:`, `minimum_chrome_version: "119"`,
   no `browser_specific_settings`).
3. Copies the shared files and packs **`sentencetts-reader-chrome.zip`** plus
   `chrome-build/install-piper-host.sh`.

### Chrome install

1. Load the extension unpacked: `chrome://extensions` → enable *Developer mode*
   → *Load unpacked* → select `chrome-build/`.
2. Piper (optional but supported): register the native host **before** starting
   Chrome (manifests are read at browser launch):
   ```bash
   chrome-build/install-piper-host.sh
   ```
   This installs `chrome-build/piper-host-manifest.json` (which uses
   `allowed_origins: ["chrome-extension://b6ecf49b455c8c297c695d998f40d28a/"]`)
   into the NativeMessagingHosts dirs of google-chrome, chromium and
   microsoft-edge. Fix its `path` if your clone lives elsewhere, then fully
   restart the browser.
3. Local `file://` PDFs: in the extension's Details page enable *Allow access to
   file URLs* (Chrome allows the extension to fetch `file://` PDFs when granted,
   unlike Firefox). If the fetch is still refused the reader falls back to its
   file picker.
4. Verify: popup → engine Piper → voice dropdown should list your `.onnx`
   models; reading on novelbuddy long pages, PDFs, and auto-refresh all behave
   like Firefox.

Version bumps must stay in sync across `manifest.json`,
`build-source/manifest.chrome.json`, and `build-source/package.json`.

## Version Bumping

1. Update `version` in `manifest.json`
2. Update `version` in `build-source/manifest.chrome.json`
3. Update `version` in `build-source/package.json`
4. `cp background.js build-source/background-src.js` (this direction — the AMO
   source package must match, and reviewers run `diff` on exactly these two)
5. `node tests/run.js` — green before packaging
6. Rebuild **both** zips (Firefox zip per *Creating the Submission ZIP*; Chrome
   zip via `node build-source/build-chrome.js`), then run the four freshness
   checks above against each

Any change to a shared file (`background.js`, `content.js`, `spa-main.js`,
`kokoro-worker.js`, `offscreen.*`, `popup.*`, `pdfviewer.*`, `pdf/`, `vendor/`,
`icons/`) also requires re-running `node build-source/build-chrome.js`: the Chrome
zip is assembled from the repo root, so an un-rebuilt `chrome-build/` ships the
previous revision of those files under a new version number.

If a version is already published, do not reuse its number for a rebuild — bump
the patch level and note the superseded one in the AMO "What's new" field.

**State as of 2026-09-27:** AMO carries exactly **one** published version of this
add-on — **2.1.0** (slug `sentencetts-reader`, addon id 3066315, guid
`{d4e8a2b1-7c3f-4a9e-8b2f-5e6d7c8a9b0f}`, reviewed 2026-09-07). Nothing from the
2.2–2.3.x line was ever published, so **2.3.4 is still an unused number** and a
rebuild can keep it. Verify before every submission — the count is the answer:

```sh
curl -s 'https://addons.mozilla.org/api/v5/addons/addon/sentencetts-reader/versions/?page_size=50' \
  | grep -o '"version":"[^"]*"'
```

The slug appears nowhere in this repo (the GUID in `manifest.json` is the only
pointer), which is why it is written down here.

## Repository & Version Control

Initialized 2026-09-27, branch `main`, tracking the whole source tree (43 files
at the time of writing). The full
rationale lives in `../AGENT.md` → *Build → Repository, hooks, and the Chrome
key*; the parts that matter to packaging:

- **`chrome-build/` and both `.zip` bundles are gitignored** (regenerable).
  Consequence: `git status` stays clean while a submission bundle goes stale, so
  the freshness checks under *Creating the Submission ZIP* are the only tripwire.
- **`build-source/chrome-key.pem` is gitignored and must stay that way.** It pins
  the extension ID and the Piper `allowed_origins`; `build-chrome.js` exits 1
  without it rather than minting a new one. Verify a restored backup:
  `openssl pkey -in build-source/chrome-key.pem -pubout -outform DER | sha256sum`
  → must begin `b6ecf49b455c8c297c695d998f40d28a`.
- **`vendor/` is tracked on purpose** (23 MB; largest file 21 MB, under GitHub's
  100 MB cap, so no Git LFS) because it ships inside the extension and must match
  what AMO reviewed byte for byte.
- **Guard hook:** `git config core.hooksPath .githooks` once per clone.
  `.githooks/pre-commit` refuses a staged `*.pem`/`*.key` path or any staged file
  whose content carries a `BEGIN … PRIVATE KEY` header, and warns when
  `background.js` is committed while `background-src.js` differs. It is a local
  speed bump — `--no-verify` bypasses it, so never `git add -f` a key.
- The AMO zip must still exclude `.git/` (see *Do NOT include* above) — that
  directory now actually exists.

## Native Messaging Host

The Piper TTS engine requires a separately-installed native messaging host (`piper_host.py`). This is **not** bundled in the extension — users install it per `../PIPER_SETUP.md`. The extension only contains the client-side connection logic.

## CSP Notes

The manifest includes:
```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self' blob:;"
}
```

This allows:
- Self-hosted scripts only (no inline scripts, no remote code)
- `'wasm-unsafe-eval'` — required to compile the vendored ONNX Runtime wasm
  binary (vendor/kokoro/). This is the ONLY addition; it permits WebAssembly
  compilation, not `eval()`. All wasm/script content is served from the
  extension package itself.
- Blob workers (used by some libraries, reserved for future)
- No `eval()` or `new Function()` — verified by grep above

## Testing Before Submission

```bash
# --- Firefox (about:debugging → Load Temporary Add-on…) ---
# 1. Test all 5 engines on multiple sites:
#    - novelbuddy.me (primary target) — including a long chapter
#    - Substack, Wikipedia, Medium
# 2. Kokoro: popup → engine Kokoro → Download (~88 MB, progress survives closing
#    the popup) → Play reads offline. Stop frees the worker; the download must NOT
#    restart after a browser restart (Cache Storage hit); a second Play after Stop
#    re-spawns cleanly.
# 3. Verify the on-page player appears at the bottom while reading and survives
#    closing the popup (Firefox closes popups on focus loss by design).
# 4. Verify auto-refresh resilience: reload the tab mid-read → playback resumes;
#    a tab left cached for hours does NOT auto-resume.
# 5. PDF: open a web-hosted .pdf → popup shows "Read this PDF" → reader opens and
#    plays with page-flip + transcript highlighting. Embedded PDFs too.
# 6. Verify no console errors in:
#    - Page DevTools (content.js)
#    - Background page inspector (background.js) — click "Inspect" in about:debugging
# 7. Verify pause/resume/stop/next/prev/click-to-jump
# 8. Verify settings persist across popup close/reopen
# 9. Verify SPA navigation works (Next.js routes)

# --- Chrome (chrome://extensions → Load unpacked → chrome-build/) ---
# 10. gfree/gcloud/system/piper behave as on Firefox (piper needs
#     chrome-build/install-piper-host.sh + a full browser restart first)
# 11. Kokoro end-to-end, which is the path that differs by browser: Download →
#     Play → Stop → Play again. The offscreen document is created on demand and
#     must DISAPPEAR after Stop and come back on the second Play. With DevTools
#     attached to the service worker, watch for
#     "Kokoro offscreen document did not signal readiness" (must never appear in
#     normal use) and "spawn wedge detected" (must never appear in normal use).
# 12. Service-worker survivability: read a long chapter past the ~30 s idle
#     window and across a 5-minute pause — audio must not die mid-sentence.
# 13. Local file:// PDF after enabling "Allow access to file URLs".
```

## License

MIT — see individual files for any third-party licenses. This changed in 2.3.0:
the extension now **vendors** third-party code under `vendor/kokoro/` —
`kokoro-js` (Apache-2.0) and the `onnxruntime-web` WASM build (MIT). The
Kokoro-82M weights (Apache-2.0) are not shipped; they are downloaded at runtime
behind explicit consent. Google TTS and Piper remain external services/binaries.