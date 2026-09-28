'use strict';
// Assembles the Chrome (Chromium/Edge) build of SentenceTTS Reader into
// chrome-build/ and packs sentencetts-reader-chrome.zip.
//
//   node build-source/build-chrome.js
//
// The extension ID is derived from the RSA key in chrome-key.pem: the first
// 32 hex chars of SHA-256(SPKI DER). Keeping the same key across updates and
// reloads keeps the ID (and the Piper native-messaging allowed_origins) stable.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const keyPath = path.join(__dirname, 'chrome-key.pem');
const outDir = path.join(root, 'chrome-build');

if (!fs.existsSync(keyPath)) {
  console.error('Missing ' + keyPath + ' — cannot produce a stable extension ID.');
  process.exit(1);
}

const key = crypto.createPublicKey(fs.readFileSync(keyPath, 'utf8'));
const spkiDer = key.export({ type: 'spki', format: 'der' });
const extensionId = crypto.createHash('sha256').update(spkiDer).digest('hex').slice(0, 32);
const spkiB64 = spkiDer.toString('base64');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// ---- manifest.json (with the key baked in for a stable ID) ----
const template = fs.readFileSync(path.join(__dirname, 'manifest.chrome.json'), 'utf8');
const manifest = JSON.parse(template.replace('{{SPKI_B64}}', spkiB64));
manifest.key = spkiB64;
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// ---- shared files (identical to the Firefox build) ----
for (const f of [
  'background.js', 'content.js', 'spa-main.js', 'content.css',
  'popup.html', 'popup.js', 'popup.css',
  'pdfviewer.html', 'pdfviewer.js',
  'offscreen.html', 'offscreen.js',
]) {
  fs.copyFileSync(path.join(root, f), path.join(outDir, f));
}
fs.cpSync(path.join(root, 'pdf'), path.join(outDir, 'pdf'), { recursive: true });
fs.cpSync(path.join(root, 'icons'), path.join(outDir, 'icons'), { recursive: true });
// Kokoro engine runtime (kokoro-js web bundle + ONNX Runtime wasm) — needed
// by kokoro-worker.js in both builds. The 88 MB model is NOT here; it is
// download-on-first-use (see vendor/kokoro/README.md).
fs.cpSync(path.join(root, 'vendor'), path.join(outDir, 'vendor'), { recursive: true });
// Kokoro inference worker (module worker owned by background.js).
fs.copyFileSync(path.join(root, 'kokoro-worker.js'), path.join(outDir, 'kokoro-worker.js'));

// ---- Piper native-messaging host manifest (Chrome flavour: allowed_origins) ----
const host = {
  name: 'sentencetts_piper',
  description: 'Piper TTS bridge for SentenceTTS Reader (offline neural voices)',
  path: path.join(root, 'piper-host', 'piper_host.py'),
  type: 'stdio',
  allowed_origins: ['chrome-extension://' + extensionId + '/'],
};
const hostFile = path.join(outDir, 'piper-host-manifest.json');
fs.writeFileSync(hostFile, JSON.stringify(host, null, 2) + '\n');

// ---- install script for the native host (Linux) ----
const installSh = [
  '#!/bin/sh',
  '# Installs the sentencetts_piper native-messaging host for Chrome/Chromium/Edge on Linux.',
  '# Run after every rebuild of chrome-build/ and before launching/restarting the browser.',
  'set -e',
  'SRC="$(dirname "$0")/piper-host-manifest.json"',
  'for dir in ~/.config/google-chrome ~/.config/google-chrome-beta ~/.config/google-chrome-unstable ~/.config/chromium ~/.config/microsoft-edge ~/.config/microsoft-edge-beta ~/.config/microsoft-edge-dev; do',
  '  mkdir -p "$dir/NativeMessagingHosts"',
  '  cp "$SRC" "$dir/NativeMessagingHosts/sentencetts_piper.json"',
  '  echo "  installed -> $dir/NativeMessagingHosts/sentencetts_piper.json"',
  'done',
  'echo "Done. Fully restart the browser for the host to register."',
  '',
].join('\n');
fs.writeFileSync(path.join(outDir, 'install-piper-host.sh'), installSh);
fs.chmodSync(path.join(outDir, 'install-piper-host.sh'), 0o755);

// ---- zip the build ----
execSync('rm -f sentencetts-reader-chrome.zip && zip -r ../sentencetts-reader-chrome.zip .', {
  cwd: outDir,
  stdio: 'inherit',
});

console.log('extension id    : ' + extensionId);
console.log('build           : ' + outDir);
console.log('host manifest   : ' + hostFile);
console.log('zip             : sentencetts-reader-chrome.zip');