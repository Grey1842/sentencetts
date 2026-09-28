# vendor/kokoro — third-party runtime for the Kokoro TTS engine

This directory ships the *runtime* for the optional "Kokoro" engine (Kokoro-82M
v1.0, offline neural TTS). The 88 MB model itself is **NOT** here — it is
downloaded on first use from Hugging Face with explicit user consent in the
popup, and cached in the browser's Cache Storage.

## Files

| File | Source | Size |
|------|--------|------|
| `kokoro.web.js` | `kokoro-js@1.2.1` npm package, `dist/kokoro.web.js` (official browser bundle) | ~2.1 MB |
| `ort-wasm-simd-threaded.jsep.wasm` | `onnxruntime-web@1.22.0-dev.20250409` npm package, `dist/` | ~21.6 MB |
| `ort-wasm-simd-threaded.jsep.mjs` | same package, `dist/` (emscripten loader the ORT glue dynamically imports) | ~44 KB |

## Why these exact versions

`kokoro.web.js` is the self-contained browser bundle of kokoro-js: it embeds
`@huggingface/transformers@3.5.1`, its ONNX Runtime web glue
(`1.22.0-dev.20250409`) and the `phonemizer` package. Left unconfigured, that
glue fetches the WASM binary from jsdelivr at runtime — that would be
remote-hosted code, which AMO forbids. `background.js` therefore sets
`env.wasmPaths` to this directory, and the glue loads the two ORT files from
the extension package instead. The vendored ORT files are byte-identical to
the version the bundle's glue was built against (verified version string
`1.22.0-dev.20250409`), so the ABI matches.

## Licenses

- kokoro-js — Apache-2.0 (includes Kokoro-82M weights access + phonemizer)
- Kokoro-82M model — Apache-2.0 (downloaded at runtime, not shipped here)
- onnxruntime-web — MIT

## How a reviewer can reproduce these files

```
npm install kokoro-js@1.2.1
cp node_modules/kokoro-js/dist/kokoro.web.js        vendor/kokoro/
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm vendor/kokoro/
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs  vendor/kokoro/
```

(The ONNX Runtime version installed under `@huggingface/transformers` must be
`1.22.0-dev.20250409` to match the glue inside the bundle.)

## CSP

Loading these files requires `'wasm-unsafe-eval'` in
`content_security_policy.extension_pages.script-src` (both manifests). No
remote code is loaded at any point; the only runtime fetches are **data**
(model + voice files from huggingface.co) initiated by the user via the popup
download button.
