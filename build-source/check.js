'use strict';
// Release gate for SentenceTTS Reader:
//
//   node build-source/check.js
//
// Verifies the invariants a release depends on, so they are checked rather than
// remembered:
//
//   1  version parity   manifest.json, build-source/manifest.chrome.json and
//                       build-source/package.json agree (plus chrome-build's, if built)
//   2  source parity    background.js == build-source/background-src.js — the diff
//                       AMO reviewers run, so it must be empty
//   3  syntax           node --check over every shipped script
//   4  Firefox zip      required entries present, forbidden entries absent, every
//                       entry byte-identical to the tree
//   5  Chrome build     chrome-build/ and the Chrome zip still match the tree
//   6  key handling     chrome-key.pem exists, is git-ignored, and is in no zip
//
// Read-only: it never writes or repairs anything. Exit 0 = clean, exit 1 = drift,
// so it is safe to chain into a release step. Paths resolve from __dirname, so the
// current directory does not matter — it behaves the same in the repo and inside an
// unpacked submission package.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const at = (...p) => path.join(ROOT, ...p);

let checks = 0;
let failures = 0;
let skipped = 0;

function ok(label, detail) { checks++; console.log('  ok   ' + label + (detail ? '  (' + detail + ')' : '')); }
function bad(label, detail) { checks++; failures++; console.log('  FAIL ' + label + (detail ? '  (' + detail + ')' : '')); }
function skip(label, why) { checks++; skipped++; console.log('  skip ' + label + '  (' + why + ')'); }

const exists = (p) => fs.existsSync(p);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sameBytes = (a, b) => exists(a) && exists(b) && fs.readFileSync(a).equals(fs.readFileSync(b));

// Recursively list files under dir as POSIX paths relative to dir.
function listFiles(dir, relBase) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relBase ? relBase + '/' + ent.name : ent.name;
    if (ent.isDirectory()) out.push(...listFiles(path.join(dir, ent.name), rel));
    else out.push(rel);
  }
  return out;
}

// ----------------------------------------------------------------- CRC-32 + zip
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Read a zip's central directory: name -> { crc, size }. Parsing the structure
// directly means no unzip binary and no decompression of the 23 MB of vendor
// payloads — the CRC stored in the header is compared against the tree file.
function zipEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  let pos = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65557; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { pos = i; break; }
  }
  if (pos < 0) throw new Error('no end-of-central-directory record — not a zip?');
  const count = buf.readUInt16LE(pos + 10);
  const cdOffset = buf.readUInt32LE(pos + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error('zip64 archive, not handled here');
  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('central directory out of sync');
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const fnLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.slice(p + 46, p + 46 + fnLen).toString('utf8');
    if (!name.endsWith('/')) entries.set(name, { crc, size });
    p += 46 + fnLen + extraLen + commentLen;
  }
  return entries;
}

// Compare every entry against the working tree. `generated` names are produced by
// build-chrome.js and have no counterpart in the tree, so they are skipped.
function compareZipToTree(zipPath, generated) {
  const skip = generated || new Set();
  const entries = zipEntries(zipPath);
  const missing = [];
  const mismatched = [];
  let compared = 0;
  for (const [name, meta] of entries) {
    if (skip.has(name)) continue;
    compared++;
    const file = at(name);
    if (!exists(file)) { missing.push(name); continue; }
    if (crc32(fs.readFileSync(file)) !== meta.crc) mismatched.push(name);
  }
  return { entries, missing, mismatched, compared };
}


// ---------------------------------------------------------------------------- run
console.log('SentenceTTS Reader release check — root ' + ROOT);

// 1 — version parity -------------------------------------------------------------
console.log('\nversion parity');
{
  const sources = [
    ['manifest.json', () => readJson(at('manifest.json')).version],
    ['build-source/manifest.chrome.json', () => readJson(at('build-source', 'manifest.chrome.json')).version],
    ['build-source/package.json', () => readJson(at('build-source', 'package.json')).version],
  ];
  const found = new Map();
  for (const [rel, read] of sources) {
    try { found.set(rel, read()); } catch (err) { bad(rel + ' unreadable', err.message.split('\n')[0]); }
  }
  const values = new Set(found.values());
  if (values.size === 1 && found.size === sources.length) {
    ok('manifest, Chrome template, package.json', 'v' + [...values][0]);
  } else {
    for (const [rel, v] of found) console.log('         ' + rel + ' = ' + v);
    bad('version fields disagree', values.size + ' distinct values across ' + found.size + ' files');
  }
  const firefoxVersion = found.get('manifest.json');
  const builtManifest = at('chrome-build', 'manifest.json');
  if (!exists(builtManifest)) skip('chrome-build/manifest.json', 'not built — node build-source/build-chrome.js');
  else {
    const v = readJson(builtManifest).version;
    if (v === firefoxVersion) ok('chrome-build/manifest.json', 'v' + v);
    else bad('chrome-build/manifest.json stale', 'v' + v + ' vs v' + firefoxVersion);
  }
}

// 2 — AMO source parity ----------------------------------------------------------
console.log('\nAMO source parity');
{
  const a = at('background.js');
  const b = at('build-source', 'background-src.js');
  if (!exists(a) || !exists(b)) bad('background source files', 'one is missing');
  else if (fs.readFileSync(a).equals(fs.readFileSync(b))) {
    ok('background.js == background-src.js', fs.statSync(a).size + ' B, so AMO diff output is empty');
  } else {
    bad('background-src.js drifts from background.js',
      fs.statSync(b).size + ' B vs ' + fs.statSync(a).size + ' B — fix: cp background.js build-source/background-src.js');
  }
}

// 3 — syntax ---------------------------------------------------------------------
console.log('\nsyntax');
{
  const files = [
    'background.js', 'content.js', 'spa-main.js', 'popup.js', 'pdfviewer.js',
    'kokoro-worker.js', 'offscreen.js', 'build-source/build-chrome.js', 'build-source/check.js',
  ];
  const broken = [];
  let n = 0;
  for (const rel of files) {
    if (!exists(at(rel))) continue;
    n++;
    const res = spawnSync(process.execPath, ['--check', at(rel)], { encoding: 'utf8' });
    if (res.status !== 0) broken.push(rel + ': ' + (res.stderr || '').trim().split('\n')[0]);
  }
  if (broken.length) for (const line of broken) bad('syntax', line);
  else ok('every shipped script parses', n + ' files, node --check');
}

// 4 — Firefox submission zip -----------------------------------------------------
console.log('\nFirefox submission zip');
{
  const zipPath = at('sentencetts-reader.zip');
  if (!exists(zipPath)) {
    skip('sentencetts-reader.zip', 'absent — npm run package, or the zip command in BUILD.md');
  } else {
    const { entries, missing, mismatched } = compareZipToTree(zipPath);
    const names = [...entries.keys()];

    const required = [
      'manifest.json', 'LICENSE', 'background.js', 'kokoro-worker.js', 'content.js', 'spa-main.js',
      'content.css', 'popup.html', 'popup.js', 'popup.css', 'pdfviewer.html', 'pdfviewer.js',
      'pdf/pdf.mjs', 'pdf/pdf.worker.mjs',
      'vendor/kokoro/kokoro.web.js', 'vendor/kokoro/ort-wasm-simd-threaded.jsep.wasm',
      'vendor/kokoro/ort-wasm-simd-threaded.jsep.mjs', 'vendor/kokoro/README.md',
      'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png',
      'icons/icon-64.png', 'icons/icon-96.png', 'icons/icon-128.png',
      'build-source/background-src.js', 'build-source/BUILD.md', 'build-source/package.json',
      'build-source/check.js',
    ];
    const absent = required.filter((r) => !entries.has(r));
    if (absent.length) bad('required entries missing', absent.join(', '));
    else ok('required entries present', required.length + ' required, ' + names.length + ' in archive');

    // Each of these would put a build artefact, a secret, or repo-only documentation
    // into a publicly downloadable listing.
    const forbidden = [
      ['offscreen host', /(^|\/)offscreen\.(html|js)$/],
      ['*.pem (private key)', /\.pem$/],
      ['manifest.chrome.json', /(^|\/)manifest\.chrome\.json$/],
      ['build-chrome.js', /(^|\/)build-chrome\.js$/],
      ['piper-host/', /(^|\/)piper-host\//],
      ['tests/', /(^|\/)tests\//],
      ['__pycache__', /__pycache__/],
      ['.git', /(^|\/)\.git/],
      ['node_modules', /(^|\/)node_modules\//],
      ['chrome-build/', /(^|\/)chrome-build\//],
      ['repo-only docs', /(^|\/)(AGENT|KOKORO_SPIKE|PIPER_SETUP|CLAUDE|GEMINI|CONTRIBUTING|CHANGELOG)\.md$/],
      ['root README.md', /^README\.md$/],
      ['*.py', /\.py$/],

    ];
    const leaks = forbidden.filter(([, re]) => names.some((n) => re.test(n)));
    if (leaks.length) for (const [label] of leaks) bad('forbidden content in zip', label);
    else ok('no forbidden entries', forbidden.length + ' patterns, 0 matches');

    if (missing.length) bad('zip entries absent from tree', missing.join(', '));
    if (mismatched.length) bad('zip entries differ from tree', mismatched.join(', '));
    if (!missing.length && !mismatched.length) {
      ok('every entry byte-identical to the tree', names.length + ' files, CRC-32 compare');
    }

    if (entries.has('manifest.json')) {
      const fresh = crc32(fs.readFileSync(at('manifest.json'))) === entries.get('manifest.json').crc;
      if (fresh) ok('zipped manifest is the current one', 'v' + readJson(at('manifest.json')).version);
      else bad('zipped manifest is stale', 'rebuild the zip after the last edit — BUILD.md ships inside it');
    }

    const bytes = [...entries.values()].reduce((s, e) => s + e.size, 0);
    ok('archive size', (fs.statSync(zipPath).size / 1048576).toFixed(2) + ' MB compressed, ' +
      (bytes / 1048576).toFixed(2) + ' MB unpacked');
  }
}

// 5 — Chrome build ---------------------------------------------------------------
console.log('\nChrome build');
{
  const shared = [
    'background.js', 'content.js', 'spa-main.js', 'content.css',
    'popup.html', 'popup.js', 'popup.css',
    'pdfviewer.html', 'pdfviewer.js', 'offscreen.html', 'offscreen.js', 'kokoro-worker.js',
    'LICENSE',
  ];
  const dirs = ['pdf', 'icons', 'vendor'];
  if (!exists(at('chrome-build', 'manifest.json'))) {
    skip('chrome-build/', 'absent — node build-source/build-chrome.js');
  } else {
    const stale = shared.filter((f) => exists(at(f)) && !sameBytes(at(f), at('chrome-build', f)));
    for (const d of dirs) {
      if (!exists(at(d))) continue;
      for (const rel of listFiles(at(d), '')) {
        if (!sameBytes(at(d, rel), at('chrome-build', d, rel))) stale.push(d + '/' + rel);
      }
    }
    if (stale.length) {
      bad('chrome-build/ is stale', stale.slice(0, 6).join(', ') + (stale.length > 6 ? ' +' + (stale.length - 6) + ' more' : ''));
    } else ok('chrome-build/ matches the tree', shared.length + ' scripts + ' + dirs.join('/') + '/');
  }

  const chromeZip = at('sentencetts-reader-chrome.zip');
  if (!exists(chromeZip)) skip('sentencetts-reader-chrome.zip', 'absent');
  else {
    // build-chrome.js generates these three inside chrome-build/, so the zip's copy
    // is not comparable to a file in the tree (manifest.json carries the baked key).
    const generated = new Set(['manifest.json', 'piper-host-manifest.json', 'install-piper-host.sh']);
    const { entries, missing, mismatched, compared } = compareZipToTree(chromeZip, generated);
    const names = [...entries.keys()];
    if (names.some((n) => /(^|\/)offscreen\.(html|js)$/.test(n))) {
      ok('offscreen host shipped', 'Chrome-only, and correctly absent from the Firefox zip');
    } else bad('offscreen host missing', 'the Chrome Kokoro engine depends on it');
    const keyLeak = names.filter((n) => /\.pem$/.test(n));
    if (keyLeak.length) bad('private key inside Chrome zip', keyLeak.join(', '));
    else ok('no private key in Chrome zip', 'no *.pem entry');
    if (missing.length || mismatched.length) {
      bad('Chrome zip drifts from tree', [...missing, ...mismatched].slice(0, 6).join(', '));
    } else ok('Chrome zip byte-identical to tree', compared + ' compared, 3 generated files skipped');
  }
}

// 6 — key handling ---------------------------------------------------------------
console.log('\nChrome key handling');
{
  const key = at('build-source', 'chrome-key.pem');
  if (!exists(key)) {
    skip('chrome-key.pem', 'absent — the Chrome build cannot pin the published extension ID');
  } else {
    ok('chrome-key.pem present', 'pins the Chrome extension ID and the Piper host allowed_origins');
    const ign = spawnSync('git', ['check-ignore', '-q', 'build-source/chrome-key.pem'], { cwd: ROOT });
    if (ign.status === 0) ok('git-ignored', '.gitignore plus the .githooks/pre-commit guard');
    else if (ign.status === 1) bad('chrome-key.pem is NOT git-ignored', 'fix .gitignore, then git config core.hooksPath .githooks');
    else skip('git-ignored', 'git unavailable here');
  }
}

// summary ------------------------------------------------------------------------
console.log('');
if (failures) {
  console.log('FAILED ' + failures + ' of ' + checks + ' checks (' + skipped + ' skipped)');
  process.exit(1);
}
console.log('PASSED ' + (checks - skipped) + '/' + checks + ' checks (' + skipped + ' skipped)');



