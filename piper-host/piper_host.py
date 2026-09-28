#!/usr/bin/env python3
"""
Native messaging host for SentenceTTS Reader — Piper TTS bridge.

The browser extension (background.js) calls runtime.sendNativeMessage with a
JSON object. Firefox/Chrome deliver it on stdin as:
    <4-byte little-endian length><JSON bytes>
We respond the same way on stdout.

Messages (JSON):
  in:  { "cmd": "list" }
  out: { "ok": true, "models": ["en_US-amy-low.onnx", ...] }

  in:  { "cmd": "synthesize", "text": "...", "model": "en_US-amy-low.onnx",
         "length_scale": 1.0, "noise_scale": 0.667 }
  out: { "ok": true, "audio_base64": "<base64 WAV>" }
       or { "ok": false, "error": "..." }

INSTALL
  1) Edit VOICES_DIR below to point at your Piper .onnx voice models folder.
  2) Make this file executable:  chmod +x piper_host.py
  3) Install the host manifest — see piper_host_manifest.json and the
     install instructions in ../PIPER_SETUP.md.
"""
import json
import struct
import sys
import os
import subprocess
import base64
import glob
import select

# --------------------------------------------------------------------
# CONFIG — change these to match your system.
# --------------------------------------------------------------------
PIPER_BIN = "piper"            # or an absolute path, e.g. "/usr/bin/piper"
# The host scans ALL of these directories for .onnx voice models:
VOICES_DIRS = [
    os.path.expanduser("~/.local/share/piper-voices"),  # user downloads
    "/usr/share/piper-voices",                           # system packages (pacman/apt/dnf)
]
# The host is a long-lived browser-native process. To stop it eating RAM
# while the browser sits idle, it auto-exits after this many seconds without
# any messages. The extension spawns a fresh host on the next synthesis, and
# background.js already treats "host not reachable" as a transient, retryable
# error, so an idle-exit is completely safe.
IDLE_TIMEOUT_SECS = 10 * 60   # 10 minutes of inactivity => exit to free memory
# Host-side guard for a single synthesize request. The extension chunks to
# <=2000 chars, but the host must not trust callers — an oversized request
# would return a giant base64 blob (native-messaging replies cap near 50MB)
# and pin RAM on both ends. Rejections surface as normal synthesis errors.
MAX_TEXT_CHARS = 8000
# --------------------------------------------------------------------

MODEL_EXT = ".onnx"


def log(msg):
    # Native-messaging hosts must not write to stdout; log to stderr only
    # (visible in the browser's terminal if launched from one).
    sys.stderr.write("[piper_host] " + str(msg) + "\n")
    sys.stderr.flush()


def read_message(timeout=None):
    """Read one native-messaging message from stdin. Returns dict or None on EOF.

    If timeout is given, blocks at most that many seconds waiting for the 4-byte
    length header; when the timeout elapses with no data it returns None (used by
    the idle-exit below). None is also returned on EOF or a malformed message.
    """
    if timeout is not None:
        r, _, _ = select.select([sys.stdin.buffer], [], [], timeout)
        if not r:
            return None  # no data within timeout
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("=I", raw_len)
    if length == 0 or length > 50 * 1024 * 1024:
        return None  # sanity cap
    raw = sys.stdin.buffer.read(length)
    if len(raw) < length:
        return None
    return json.loads(raw.decode("utf-8"))


def send_message(obj):
    """Write one native-messaging message to stdout."""
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def list_models():
    models = []
    for d in VOICES_DIRS:
        if os.path.isdir(d):
            for f in sorted(glob.glob(os.path.join(d, "**", "*" + MODEL_EXT), recursive=True)):
                # Return relative path from the voices dir so we can find it again
                rel = os.path.relpath(f, d)
                models.append(rel)
    return sorted(set(models))  # dedupe


def find_model_file(model_name):
    """Find a model file by name across all VOICES_DIRS."""
    if not model_name:
        return None
    # If absolute or relative path already exists, use it
    if os.path.isabs(model_name) and os.path.isfile(model_name):
        return model_name
    # Search in each VOICES_DIR
    for d in VOICES_DIRS:
        # Try direct basename match first
        cand = os.path.join(d, os.path.basename(model_name))
        if os.path.isfile(cand):
            return cand
        # Try relative path match
        cand2 = os.path.join(d, model_name)
        if os.path.isfile(cand2):
            return cand2
    return None


def synthesize(text, model, length_scale=1.0, noise_scale=0.667):
    """Run piper on stdin text, capture WAV, return base64."""
    if not text:
        raise ValueError("empty text")
    # Hardening: the extension chunks to <=2000 chars, but the host must not
    # trust that — a single huge message would otherwise return a giant base64
    # blob (native-messaging replies cap at ~50MB) and pin RAM on both ends.
    if len(text) > MAX_TEXT_CHARS:
        raise ValueError(
            "text too long (%d chars, max %d) — shorten the request" % (len(text), MAX_TEXT_CHARS)
        )
    try:
        length_scale = float(length_scale)
    except (TypeError, ValueError):
        raise ValueError("bad length_scale: %r" % (length_scale,))
    try:
        noise_scale = float(noise_scale)
    except (TypeError, ValueError):
        raise ValueError("bad noise_scale: %r" % (noise_scale,))
    # Piper only behaves for sane scales; clamp defensively instead of failing.
    length_scale = min(4.0, max(0.25, length_scale))
    noise_scale = min(2.0, max(0.0, noise_scale))
    model_file = find_model_file(model) if model else None
    # Default to first available model if none given.
    if not model_file or not os.path.isfile(model_file):
        avail = list_models()
        if not avail:
            dirs_str = ", ".join(VOICES_DIRS)
            raise ValueError(
                "no Piper models found in any of: " + dirs_str + ". Edit VOICES_DIRS in piper_host.py."
            )
        model_file = find_model_file(avail[0])

    # piper reads text from stdin (--input_file -) and writes WAV to stdout.
    cmd = [
        PIPER_BIN,
        "-m", model_file,
        "-f", "-",                 # output WAV to stdout
        "--length-scale", str(length_scale),
        "--noise-scale", str(noise_scale),
    ]
    log("running: " + " ".join(cmd))
    proc = subprocess.run(
        cmd,
        input=text.encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        raise ValueError("piper failed (code %d): %s" % (proc.returncode, err[:500]))
    wav = proc.stdout
    if not wav:
        raise ValueError("piper produced no audio output")
    return base64.b64encode(wav).decode("ascii")


def main():
    while True:
        # Block up to IDLE_TIMEOUT_SECS for the next message; if nothing
        # arrives, exit the host to release the RAM it (and any spawned temp)
        # holds. The browser restarts us on demand, so this is transparent.
        msg = read_message(timeout=IDLE_TIMEOUT_SECS)
        if msg is None:
            log("idle for %ds — exiting to free memory" % IDLE_TIMEOUT_SECS)
            break
        try:
            cmd = msg.get("cmd")
            if cmd == "list":
                send_message({"ok": True, "models": list_models()})
            elif cmd == "synthesize":
                wav_b64 = synthesize(
                    msg.get("text", ""),
                    msg.get("model", ""),
                    float(msg.get("length_scale", 1.0)),
                    float(msg.get("noise_scale", 0.667)),
                )
                send_message({"ok": True, "audio_base64": wav_b64})
            elif cmd == "shutdown":
                # The extension can ask us to exit immediately (e.g. when it
                # stops reading) so piper's memory is freed right away.
                log("shutdown requested")
                send_message({"ok": True})
                break
            else:
                send_message({"ok": False, "error": "unknown cmd: " + str(cmd)})
        except Exception as e:
            send_message({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
