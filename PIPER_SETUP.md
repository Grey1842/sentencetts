# Piper Native Messaging Host Setup for SentenceTTS Reader

This guide covers installing and configuring the Piper TTS native messaging host for the SentenceTTS Reader extension (Firefox and Chrome/Edge builds share the same host script).

## Install model (read this first)

The host script runs **in place** from this repository — there is no copy step.
The shipped manifest (`piper-host/piper_host_manifest.json`) points `path`
directly at `piper-host/piper_host.py` in your clone. You only do two things:

1. Make the host executable (it is run by Firefox, not a person, so the
   executable bit must be set).
2. Install the *manifest* into Firefox's native-messaging directory — and, if
   your clone lives somewhere other than where this file is, fix the absolute
   `path` inside it.

This keeps one copy of the host (no repo-vs-installed drift) and means the
running host always reflects the current repo code. If you move or rename the
repo, update the manifest's `path` — that is the only coupling.

## Installation Steps

### 1. Install the Piper Binary

On Linux (Arch), install Piper via AUR:
```bash
# Using yay (AUR helper)
yay -S piper-tts-git

# Or manually build from AUR
git clone https://aur.archlinux.org/piper-tts-git.git
cd piper-tts-git
makepkg -si
```

The Piper binary will be installed to: `/usr/lib/piper-tts/bin/piper`

The host's `PIPER_BIN` defaults to `"piper"` on PATH. If your `piper` is not on
PATH or you want to be explicit, set the absolute path in `piper_host.py`:
```python
PIPER_BIN = "/usr/lib/piper-tts/bin/piper"  # or leave "piper" if on PATH
```

### 2. Install Voice Models

Piper looks for `.onnx` voice models in these directories:
- `~/.local/share/piper-voices` (user-installed)
- `/usr/share/piper-voices` (system packages)

On Arch, you can install voice models via:
```bash
yay -S piper-voices-en_US  # English voices
yay -S piper-voices-en_IN  # Indian English voices (if available)
```

Or download `.onnx` files manually from:
- https://huggingface.co/rhasspy/piper-voices
- Place them in `~/.local/share/piper-voices/`

If your models live elsewhere, add the directory to `VOICES_DIRS` in
`piper_host.py`.

### 3. Make the host executable

The host runs in place from `piper-host/piper_host.py` — do not copy it
elsewhere. Just ensure Firefox can execute it:
```bash
chmod +x piper-host/piper_host.py
```

If `python3` is not at `/usr/bin/env python3`, also fix the shebang on line 1
of `piper_host.py`.

### 4. Install the Native Messaging Manifest

Copy the manifest into Firefox's native-messaging hosts directory:
```bash
mkdir -p ~/.mozilla/native-messaging-hosts
cp piper-host/piper_host_manifest.json ~/.mozilla/native-messaging-hosts/sentencetts_piper.json
```

Then open the installed copy and make sure the `path` is the **absolute** path to
`piper_host.py` in **your** clone of this repo:
```json
{
  "name": "sentencetts_piper",
  "description": "Piper TTS bridge for SentenceTTS Reader (offline neural voices)",
  "path": "/home/YOU/path/to/sentencetts-reader/piper-host/piper_host.py",
  "type": "stdio",
  "allowed_extensions": ["sentencetts-reader@local.dev"]
}
```

The shipped manifest is already correct for the repo location it shipped from;
change the `path` only if you cloned the repo elsewhere. `path` must be
absolute (Firefox rejects relative paths) and must resolve to the same
`piper_host.py` you made executable in step 3.

### 5. Verify Installation

1. Restart Firefox completely (native-messaging manifests are read at startup).
2. Load the extension: `about:debugging#/runtime/this-firefox` → **Load
   Temporary Add-on…** → select `manifest.json`.
3. Open the SentenceTTS Reader popup and select **Piper** as the engine.
4. The **voice/model dropdown should populate** with the `.onnx` models found in
   your `VOICES_DIRS`. A populated dropdown means the host launched and the
   `list` command round-tripped end to end.
5. If the dropdown stays empty or you see **"Piper host not reachable"**, the
   host did not launch — check, in order:
   - `path` in `~/.mozilla/native-messaging-hosts/sentencetts_piper.json` is
     absolute and correct, and resolves to the executable `piper_host.py`.
   - Firefox was fully restarted after you installed the manifest (step 1).
   - At least one `.onnx` model exists under a `VOICES_DIRS` directory.

The extension's background script logs nothing during normal operation, so do
not expect routine `[Piper] …` lines in the background inspector. If Piper
synthesis **fails**, the background console prints
`[SentenceTTS][background][piper] synthesis failed:` with the host's verbatim
error plus the offending text — copy those lines when reporting a bug. The host
itself logs to **stderr** as `[piper_host] …`; that output is visible only if you
launch Firefox from a terminal (`firefox` in a shell), where it will print, for
example, `[piper_host] running: piper -m …` per synthesis.

## Chrome / Edge (Chromium) variant

The Chrome build (`chrome://extensions` → Developer mode → *Load unpacked* →
`chrome-build/`) uses the same `piper-host/piper_host.py`, but requires a
**different host manifest**: Chrome matches hosts by `allowed_origins`
(`chrome-extension://<id>/`) instead of `allowed_extensions`.

Build the Chrome zip and generate the Chrome-ready host manifest:

```bash
node build-source/build-chrome.js
```

Then register the host **before** starting Chrome (native-messaging manifests
are read at browser launch):

```bash
chrome-build/install-piper-host.sh
```

This copies `chrome-build/piper-host-manifest.json` into the
NativeMessagingHosts directories of google-chrome, chromium and microsoft-edge
(on Linux; the manifest is regenerated per build with your repo's absolute
`path`). Keep the repo location stable, or fix the `path` in the generated
manifest. The extension ID
`b6ecf49b455c8c297c695d998f40d28a` is fixed by the `key` in
`build-source/manifest.chrome.json` (derived from `build-source/chrome-key.pem`)
— do not replace the key or Piper will refuse to talk to the extension. Finally
restart the browser and verify as in step 5 above.

## Troubleshooting

### "Piper host not reachable"
- The host script is executable (`chmod +x piper_host.py`).
- The manifest `path` is absolute, correct, and points at the host in your
  clone (not a copied location).
- Firefox was fully restarted after installing the manifest.
- The Piper binary exists at the `PIPER_BIN` path in `piper_host.py`.
- The host is a Python 3 script — verify `/usr/bin/env python3` resolves
  (`head -1 piper_host.py`).

### No models in the dropdown
- Check `~/.local/share/piper-voices/` and `/usr/share/piper-voices/` for `.onnx`
  files, or whatever you added to `VOICES_DIRS` in `piper_host.py`.
- Run the host manually with a properly length-prefixed message (native
  messaging uses a 4-byte little-endian length header, **not** a raw line).
  This parses the response and **prints it**, so it's a real diagnostic:
```bash
python3 - <<'PY'
import struct, subprocess, json
msg = json.dumps({"cmd": "list"}).encode()
result = subprocess.run(
    ["python3", "piper-host/piper_host.py"],
    input=struct.pack("=I", len(msg)) + msg,
    capture_output=True,
)
resp_len = struct.unpack("=I", result.stdout[:4])[0]
print(json.dumps(json.loads(result.stdout[4:4+resp_len]), indent=2))
if result.stderr:
    print("--- stderr ---\n" + result.stderr.decode(errors="replace"))
PY
```
  A non-empty `models` array in the printed output means the host and
  `VOICES_DIRS` are fine — the problem is Firefox not reaching it (manifest
  `path` / restart). Any `[piper_host]` lines under `--- stderr ---` show the
  host launched; `error` fields in the printed JSON point at the failure.

### Audio sounds distorted
- Piper may need different `length_scale`/`noise_scale` parameters
  (controlled by the extension's speed/pitch sliders).
- Try a different voice model (`.onnx` file).

## Security Notes

The native messaging host only communicates with the extension ID
defined in `manifest.json` (see **Important: Extension ID Changes** for
the current value and how to keep the installed manifest in sync). No
data leaves your machine — all TTS synthesis happens locally.

Two further hardening rules are enforced by the host itself:

- **Model names are bare filenames only.** The `model` field arrives from
  extension storage and is never trusted as a path: absolute paths and
  anything containing a path separator are rejected outright, so a
  tampered preference cannot point the `piper` binary at an arbitrary
  file on disk. Use the filename exactly as the popup's model list shows
  it (e.g. `en_US-arctic-medium.onnx`).
- **A hung `piper` is killed after 110 seconds.** A wedged model load or
  stalled synthesis can no longer pin the host's RAM indefinitely: the
  host kills the subprocess and returns a "timed out" error, which the
  extension classifies as non-retryable (just under its own 120 s
  timeout ceiling).

## Important: Extension ID Changes

If the extension's `gecko.id` in `manifest.json` ever changes, you **must**
update the installed native messaging manifest at:
`~/.mozilla/native-messaging-hosts/sentencetts_piper.json`

The `allowed_extensions` array in that file must match the current
`gecko.id` exactly (including the `{...}` braces for GUID format). The
repo's `piper-host/piper_host_manifest.json` is updated during
development, but the **installed copy is what Firefox actually reads** —
it is not auto-synced.

To fix a mismatch:
```bash
# Option 1: Re-run the installation step (step 4 in this guide)
cp piper-host/piper_host_manifest.json ~/.mozilla/native-messaging-hosts/sentencetts_piper.json
# Then fix the `path` if your clone location differs from the repo default

# Option 2: Edit the installed file directly
# Change only the `allowed_extensions` value to the new ID
```

Then restart Firefox completely.

For the **Chrome** build, the analogous requirement is that
`chrome-build/piper-host-manifest.json`'s `allowed_origins` must contain
`chrome-extension://b6ecf49b455c8c297c695d998f40d28a/` (the ID fixed by
`build-source/manifest.chrome.json`'s `key`). If you ever regenerate
`chrome-key.pem` or change that key, `node build-source/build-chrome.js` updates
the host manifest automatically — re-run `install-piper-host.sh` and restart the
browser.
