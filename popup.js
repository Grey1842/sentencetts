(function () {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;
  let activeTabId = null;
  let statusTimer = null;

  const els = {
    playPause: document.getElementById('play-pause'),
    stop: document.getElementById('stop'),
    prev: document.getElementById('prev'),
    next: document.getElementById('next'),
    rate: document.getElementById('rate'),
    rateVal: document.getElementById('rate-val'),
    pitch: document.getElementById('pitch'),
    pitchVal: document.getElementById('pitch-val'),
    engine: document.getElementById('engine'),
    voice: document.getElementById('voice'),           // hidden input stores selected value
    voiceSearch: document.getElementById('voice-search'), // text input with list="voice-list"
    voiceList: document.getElementById('voice-list'),  // datalist element
    voiceHint: document.getElementById('voice-hint'),
    piperSetup: document.getElementById('piper-setup'),
    piperSetupText: document.getElementById('piper-setup-text'),
    piperRecheck: document.getElementById('piper-recheck'),
    kokoroSetup: document.getElementById('kokoro-setup'),
    kokoroStatusText: document.getElementById('kokoro-status-text'),
    kokoroDownload: document.getElementById('kokoro-download'),
    kokoroBar: document.getElementById('kokoro-bar'),
    kokoroBarFill: document.getElementById('kokoro-bar-fill'),
    voiceField: document.querySelector('.voice-field'),
    status: document.getElementById('status'),
    error: document.getElementById('error'),
    gcloudKeyField: document.getElementById('gcloud-key-field'),
    gcloudKey: document.getElementById('gcloud-key'),
    gcloudSave: document.getElementById('gcloud-save'),
    gcloudKeyStatus: document.getElementById('gcloud-key-status'),
    piperHelp: document.getElementById('piper-help'),
    pdfBanner: document.getElementById('pdf-banner'),
    pdfBannerText: document.getElementById('pdf-banner-text'),
    pdfOpen: document.getElementById('pdf-open'),
  };

  // Bold filled transport icons (24x24 Material-style paths) — Unicode
  // glyphs render thin or emoji-like depending on OS/font.
  const ICON_PLAY_PATH = 'M8 5v14l11-7z';
  const ICON_PAUSE_PATH = 'M6 19h4V5H6v14zm8-14v14h4V5h-4z';

  function svgIcon(d, w, h) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
    return svg;
  }

  function setPlayBtn(d, label) {
    els.playPause.textContent = '';
    els.playPause.appendChild(svgIcon(d, 14, 14));
    const span = document.createElement('span');
    span.textContent = label;
    els.playPause.appendChild(span);
  }

  const prefs = { engine: 'gfree', speed: 1, pitch: 1, voice: '' };
  let activeTab = null;
  let pdfTarget = null; // { url, tabId } once a PDF is found on this tab

  // Per-engine voice data. Each engine populates this differently.
  // voices: [{ id, label, meta }]  — id is what content.js expects.
  let voiceList = [];
  let gcloudVoices = null;   // cached fetch of the user's account voices
  let piperModels = null;

  async function getActiveTab() {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  }
  async function sendMsg(msg) {
    if (!activeTabId) return null;
    try { return await api.tabs.sendMessage(activeTabId, msg); }
    catch (e) { return null; }
  }
  async function bgSend(msg) {
    try { return await api.runtime.sendMessage(msg); }
    catch (e) { return null; }
  }
  function showError(t) { els.error.textContent = t; els.error.style.display = 'block'; }
  function hideError() { els.error.style.display = 'none'; }

  // ------------------------------------------------------------
  // PDF detection — lets users read PDFs (built-in viewer or embedded)
  // through the bundled pdfviewer.html reader.
  // ------------------------------------------------------------
  function isPdfUrl(u) {
    if (!u) return false;
    return (
      /\.pdf($|[?#])/i.test(u) ||
      /^data:application\/pdf/i.test(u) ||
      (/^file:/i.test(u) && /\.pdf($|[?#])/i.test(u))
    );
  }
  async function refreshPdfInfo() {
    pdfTarget = null;
    els.pdfBanner.style.display = 'none';
    if (!activeTab) return;
    const topUrl = activeTab.url || '';
    if (isPdfUrl(topUrl)) {
      pdfTarget = { url: topUrl, tabId: activeTab.id };
      els.pdfBannerText.textContent = 'This tab is a PDF — read it out loud in the reader';
    } else {
      const probe = await sendMsg({ type: 'ttsr-pdf-probe' });
      if (probe && probe.ok && probe.pdfUrls && probe.pdfUrls.length) {
        pdfTarget = { url: probe.pdfUrls[0], tabId: activeTab.id };
        els.pdfBannerText.textContent = 'PDF found on this page — read it out loud in the reader';
      }
    }
    if (pdfTarget) els.pdfBanner.style.display = 'flex';
  }

  async function loadPrefs() {
    const s = await api.storage.local.get(['ttsr_engine', 'ttsr_speed', 'ttsr_pitch', 'ttsr_voice']);
    if (s.ttsr_engine) prefs.engine = s.ttsr_engine;
    else prefs.engine = 'gfree';
    if (typeof s.ttsr_speed === 'number') prefs.speed = s.ttsr_speed;
    if (typeof s.ttsr_pitch === 'number') prefs.pitch = s.ttsr_pitch;
    if (typeof s.ttsr_voice === 'string') prefs.voice = s.ttsr_voice;

    els.engine.value = prefs.engine;
    els.rate.value = String(prefs.speed);
    els.rateVal.textContent = prefs.speed.toFixed(1) + 'x';
    els.pitch.value = String(prefs.pitch);
    els.pitchVal.textContent = (prefs.engine === 'gfree' || prefs.engine === 'kokoro') ? 'n/a' : prefs.pitch.toFixed(1);
    els.voice.value = prefs.voice || '';  // initialize hidden input
  }
  function savePrefs() {
    api.storage.local.set({
      ttsr_engine: prefs.engine, ttsr_speed: prefs.speed,
      ttsr_pitch: prefs.pitch, ttsr_voice: prefs.voice,
    });
  }

  // ------------------------------------------------------------
  // Piper setup guidance: the popup is the only thing an AMO user ever sees
  // (PIPER_SETUP.md is not shipped), so when Piper is selected but unusable
  // we show inline, copy-pasteable setup steps instead of a dead doc pointer.
  // forEndpoint: 'firefox' (native-messaging hosts dir) or 'chrome' (host
  // manifest generator) — derived from the runtime URL scheme.
  // ------------------------------------------------------------
  let piperPing = null; // cached {reachable, models} for the current popup open
  function piperSetupPath() {
    return String((api.runtime.getURL('') || '').indexOf('chrome-extension://') === 0 ? 'chrome' : 'firefox');
  }
  function isProbablyAndroid() {
    try { return /android/i.test(navigator.userAgent || ''); } catch (e) { return false; }
  }
  async function pingPiperHost() {
    if (piperPing) return piperPing;
    const fallback = { reachable: false, models: [] };
    let res = null;
    try { res = await bgSend({ type: 'ttsr-piper-list-models' }); } catch (e) { res = null; }
    if (res && res.ok) {
      piperPing = { reachable: true, models: Array.isArray(res.models) ? res.models : [] };
    } else {
      piperPing = fallback;
    }
    return piperPing;
  }
  function piperSetupSteps(unreachable, noModels) {
    if (isProbablyAndroid()) {
      return 'Piper is not available on Firefox for Android — native messaging ' +
        'is a desktop-only feature. Offline neural voices are coming in a ' +
        'future version; for now pick System or Google Free.';
    }
    if (piperSetupPath() === 'chrome') {
      const base = '1. Install Piper: download a piper release for your OS.\n' +
        '2. Download .onnx voice models (+ matching .onnx.json) from huggingface.co/rhasspy/piper-voices into ~/.local/share/piper-voices/\n' +
        '3. In the unpacked chrome-build/ dir run: ./install-piper-host.sh (fix the path inside piper-host-manifest.json if your clone lives elsewhere)\n' +
        '4. Fully restart the browser, reopen this popup, press ↻ re-check Piper.';
      return unreachable
        ? 'Piper host not reachable — one-time local setup needed:\n' + base
        : 'Piper host answered but found no voice models:\n' + base;
    }
    // Firefox desktop. AMO users don't have this repo, so keep paths generic —
    // the host files come from the extension's source/homepage link.
    const base = '1. Install Piper (Arch: yay -S piper-tts-git; or a piper release for your OS).\n' +
      '2. Download .onnx voice models (+ matching .onnx.json) from huggingface.co/rhasspy/piper-voices into ~/.local/share/piper-voices/\n' +
      '3. Get the host files (piper_host.py + piper_host_manifest.json) from the extension source (see the add-on homepage), then register the manifest:\n' +
      '     chmod +x /path/to/sentencetts-reader/piper-host/piper_host.py\n' +
      '     mkdir -p ~/.mozilla/native-messaging-hosts\n' +
      '     cp /path/to/sentencetts-reader/piper-host/piper_host_manifest.json ~/.mozilla/native-messaging-hosts/sentencetts_piper.json\n' +
      '   (fix the absolute path inside the installed copy so it points at piper_host.py)\n' +
      '4. Fully restart Firefox, reopen this popup, press ↻ re-check Piper.';
    return unreachable
      ? 'Piper host not reachable — one-time local setup needed:\n' + base
      : 'Piper host answered but found no voice models — put .onnx files (+ .onnx.json) in ~/.local/share/piper-voices/ (see step 2 above), restart Firefox, then press ↻ re-check Piper.';
  }
  async function refreshPiperSetup() {
    const show = prefs.engine === 'piper';
    els.piperSetup.style.display = show ? 'block' : 'none';
    if (!show) return;
    els.piperSetupText.textContent = 'checking Piper…';
    piperPing = null; // never trust a stale probe for this panel
    const { reachable, models } = await pingPiperHost();
    if (reachable && models.length) {
      els.piperSetupText.textContent = 'Piper is ready — ' + models.length + ' voice model' + (models.length === 1 ? '' : 's') + ' found. Pick one above.';
    } else {
      els.piperSetupText.textContent = piperSetupSteps(!reachable, !models.length);
    }
  }

  // ------------------------------------------------------------
  // Kokoro setup panel: mirrors the model's download state via the
  // background's ttsr-kokoro-status. The consent gate is this panel — no
  // download starts until the user presses the button. Polling keeps the
  // percentage live without holding a message channel open for minutes.
  let kokoroPollTimer = null;
  function stopKokoroPoll() {
    if (kokoroPollTimer) { clearInterval(kokoroPollTimer); kokoroPollTimer = null; }
  }
  async function refreshKokoroSetup() {
    const show = prefs.engine === 'kokoro';
    els.kokoroSetup.style.display = show ? 'block' : 'none';
    if (!show) { stopKokoroPoll(); return; }
    const poll = async () => {
      const st = await bgSend({ type: 'ttsr-kokoro-status' });
      if (!st || !st.ok) {
        els.kokoroStatusText.textContent = 'Kokoro status unknown — is the extension enabled?';
        els.kokoroDownload.style.display = 'none';
        return;
      }
      if (st.phase === 'downloading') {
        els.kokoroStatusText.textContent = 'Downloading model — ' + st.pct + '%' + (st.detail ? ' (' + st.detail + ')' : '') + ' — safe to close this popup.';
        els.kokoroBar.style.display = 'block';
        els.kokoroBarFill.style.width = Math.max(2, Math.min(100, st.pct || 0)) + '%';
        els.kokoroDownload.style.display = 'none';
      } else if (st.phase === 'loading') {
        els.kokoroStatusText.textContent = 'Loading model into memory (one-time, up to a minute)…';
        els.kokoroBar.style.display = 'block';
        els.kokoroBarFill.style.width = '100%';
        els.kokoroDownload.style.display = 'none';
      } else if (st.downloaded) {
        els.kokoroBar.style.display = 'none';
        els.kokoroStatusText.textContent = st.error
          ? ('Kokoro error: ' + st.error + ' — press Download to retry.')
          : 'Kokoro model ready ✓ (stored locally, offline). Press Play to listen.';
        els.kokoroDownload.style.display = st.error ? 'inline-block' : 'none';
      } else {
        els.kokoroBar.style.display = 'none';
        // A failed download must not silently fall back to the pitch — without
        // this, "Starting download…" -> failure just re-showed the pitch with
        // no error and no bar, and Play then failed with "not downloaded yet".
        els.kokoroStatusText.textContent = st.error
          ? ('Download failed: ' + st.error + ' — press Download to retry.')
          : 'One-time ~88 MB download from huggingface.co, then fully offline. The model stays on your device and is never bundled or uploaded.';
        els.kokoroDownload.style.display = 'inline-block';
      }
    };
    await poll();
    if (!kokoroPollTimer) kokoroPollTimer = setInterval(poll, 1500);
  }
  els.kokoroDownload.addEventListener('click', async () => {
    els.kokoroStatusText.textContent = 'Starting download…';
    els.kokoroDownload.style.display = 'none';
    const res = await bgSend({ type: 'ttsr-kokoro-download' });
    if (res && res.ok === false) {
      els.kokoroStatusText.textContent = 'Could not start the download: ' + (res.error || 'unknown error');
      els.kokoroDownload.style.display = 'inline-block';
    }
  });
  window.addEventListener('unload', stopKokoroPoll);

  // Voice loading per engine
  // ------------------------------------------------------------
  // Quality heuristics for OS/browser voices. Server-side natural/neural
  // voices (Edge "Natural", Chrome "Google …", Apple Premium/Enhanced) sound
  // far better than local defaults (eSpeak, speech-dispatcher, macOS
  // "Compact"), so rank them up, sort the picker best-first, and auto-select
  // the top one when the user hasn't picked a voice.
  function systemVoiceRank(v) {
    const n = String(v.name || '');
    let r = 0;
    if (/natural|neural/i.test(n)) r += 100;
    if (/^Google /.test(n)) r += 80;
    if (/premium/i.test(n)) r += 70;
    if (/enhanced/i.test(n)) r += 60;
    if (v.localService === false) r += 15;
    if (/espeak|festival|flite|pico|compact|speech.?dispatcher/i.test(n)) r -= 100;
    return r;
  }
  function isQualitySystemVoice(v) { return systemVoiceRank(v) >= 60; }
  function rankCloud(v) {
    let r = 0;
    if (/^en-IN/i.test(v.lang || v.name)) r += 500;
    if (/Neural2|Wavenet|Journey/i.test(v.name)) r += 50;
    if (v.gender === 'FEMALE') r += 10;
    return r;
  }

  async function loadGCloudVoices() {
    if (gcloudVoices) return gcloudVoices;
    const res = await bgSend({ type: 'ttsr-gcloud-list-voices' });
    if (!res || !res.ok || !res.voices) return null;
    res.voices.sort((a, b) => rankCloud(b) - rankCloud(a));
    gcloudVoices = res.voices;
    return gcloudVoices;
  }

  async function loadPiperModels() {
    if (piperModels) return piperModels;
    const res = await bgSend({ type: 'ttsr-piper-list-models' });
    piperModels = (res && res.ok && res.models) ? res.models : [];
    return piperModels;
  }

  async function rebuildVoiceList() {
    const engine = prefs.engine;
    const query = (els.voiceSearch.value || '').trim().toLowerCase();
    // Build into a local array and assign atomically: clearing the shared
    // list BEFORE the async fetch left an empty-list window where a datalist
    // pick's commitVoiceSelection() found no match and silently dropped the
    // user's first selection (the "must select it twice" bug).
    const next = [];

    if (engine === 'gcloud') {
      const vs = await loadGCloudVoices();
      if (vs) {
        vs.forEach((v) => next.push({
          id: v.name,
          label: v.name + ' (' + (v.lang || '') + (v.gender ? ' ' + v.gender[0] : '') + ')',
          meta: ((v.lang || '') + ' ' + v.gender).toLowerCase(),
        }));
      }
    } else if (engine === 'gfree' || engine === 'system') {
      // System engine: real browser voices. Free engine: lang codes.
      if (engine === 'gfree') {
        [
          { id: 'en', label: 'English (Google Free — neutral US-ish)' },
          { id: 'en-IN', label: 'English (India) — Google Free' },
          { id: 'en-GB', label: 'English (UK) — Google Free' },
          { id: 'hi', label: 'Hindi — Google Free' },
          { id: 'hi-IN', label: 'Hindi (India) — Google Free' },
          { id: 'ta', label: 'Tamil — Google Free' },
          { id: 'te', label: 'Telugu — Google Free' },
          { id: 'mr', label: 'Marathi — Google Free' },
          { id: 'bn', label: 'Bengali — Google Free' },
        ].forEach((o) => next.push({ id: o.id, label: o.label, meta: o.label.toLowerCase() }));
      } else {
        let vs = speechSynthesis.getVoices() || [];
        const eng = vs.filter((v) => /^en/i.test(v.lang));
        const pool = (eng.length ? eng : vs).slice()
          .sort((a, b) => systemVoiceRank(b) - systemVoiceRank(a) || a.name.localeCompare(b.name));
        pool.forEach((v) => next.push({
          id: v.name,
          label: v.name + (isQualitySystemVoice(v) ? ' ★' : '') + ' (' + v.lang + ')',
          meta: (v.name + ' ' + v.lang).toLowerCase(),
        }));
        // First run with no saved voice: pick the best-sounding voice instead
        // of leaving the OS default (often a robotic eSpeak voice).
        if (!prefs.voice && next.length) {
          prefs.voice = next[0].id;
          els.voice.value = prefs.voice;
          savePrefs();
        }
      }
    } else if (engine === 'piper') {
      const ms = await loadPiperModels();
      (ms || []).forEach((m) => next.push({
        id: typeof m === 'string' ? m : (m.id || m.name || String(m)),
        label: typeof m === 'string' ? m : (m.label || m.name || String(m)),
        meta: (typeof m === 'string' ? m : JSON.stringify(m)).toLowerCase(),
      }));
    } else if (engine === 'kokoro') {
      // Kokoro ships one curated voice (af_heart) — per user request the
      // picker is hidden entirely for Kokoro; the model downloads voice
      // files on demand, so exposing 50+ choices only slowed first run.
      prefs.voice = 'af_heart';
      els.voice.value = prefs.voice;
      savePrefs();
    }

    voiceList = next;
    // Show the active voice in the search input (mirrors pdfviewer) so the
    // picker is honest about which voice is in effect. Programmatic value
    // assignment fires no events, so this cannot loop back into a commit.
    const active = voiceList.find((v) => v.id === prefs.voice);
    if (active) els.voiceSearch.value = active.label;

    renderVoiceSelect(query);
    updateEngineHints();
    refreshPiperSetup();
    refreshKokoroSetup();
  }

  function renderVoiceSelect(query) {
    const filtered = query
      ? voiceList.filter((v) => v.label.toLowerCase().includes(query) || v.meta.includes(query))
      : voiceList;

    // Update datalist options only - do NOT touch search input
    els.voiceList.textContent = '';
    if (!filtered.length && voiceList.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.label = '— no voice matches filter —';
      opt.disabled = true;
      els.voiceList.appendChild(opt);
      els.voiceHint.textContent = voiceList.length + ' voices, 0 match';
      return;
    }
    if (!voiceList.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.label = buildEmptyMessage();
      opt.disabled = true;
      els.voiceList.appendChild(opt);
      els.voiceHint.textContent = 'no voices';
      return;
    }

    filtered.forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.label = v.label;
      els.voiceList.appendChild(opt);
    });

    els.voiceHint.textContent = filtered.length + ' / ' + voiceList.length + ' voices';
  }

  function buildEmptyMessage() {
    if (prefs.engine === 'gcloud') return '— add a Google Cloud key in Advanced, then reopen —';
    if (prefs.engine === 'piper') return '— install the Piper host (PIPSetUp), restart browser —';
    if (prefs.engine === 'kokoro') return '— press the Download button above, then Play —';
    return '— no system voices — install espeak-ng / speech-dispatcher —';
  }

  function updateEngineHints() {
    els.gcloudKeyField.style.display = (prefs.engine === 'gcloud') ? 'block' : 'none';
    els.piperHelp.style.display = (prefs.engine === 'piper') ? 'block' : 'none';

    // Kokoro has no voice picker: one curated voice (af_heart), chosen
    // automatically. Hiding the field keeps the popup honest about what
    // is configurable for this engine.
    els.voiceField.style.display = (prefs.engine === 'kokoro') ? 'none' : 'block';

    // Also show a brief note in advanced for the current engine
    if (prefs.engine === 'gfree') {
      els.piperHelp.style.display = 'block';
      els.piperHelp.textContent = 'Google Free: no key needed. Indian English (en-IN) works. Character limit per request ~200 — longer sentences are auto-chunked. If audio cuts off, it may be rate-limited.';
    } else if (prefs.engine === 'gcloud') {
      els.piperHelp.style.display = 'none';
    } else if (prefs.engine === 'piper') {
      els.piperHelp.style.display = 'block';
      els.piperHelp.textContent = 'Piper needs a native-messaging host — see PIPER_SETUP.md.';
    } else if (prefs.engine === 'kokoro') {
      els.piperHelp.style.display = 'block';
      els.piperHelp.textContent = 'Kokoro: offline neural voices that run inside the browser. First use downloads an 88 MB model (one time, stored on your device). Pitch is not supported; the speed slider sets the voice\u2019s tempo (0.5\u20132x).';
    } else {
      els.piperHelp.style.display = 'none';
    }

    // pitch/rate applicability hints. Kokoro: the speed slider drives the
    // model's tempo, but pitch does nothing — show pitch as n/a there too.
    if (prefs.engine === 'gfree' || prefs.engine === 'kokoro') {
      els.pitchVal.textContent = 'n/a';
      els.rateVal.textContent = prefs.engine === 'gfree' ? 'n/a' : prefs.speed.toFixed(1) + 'x';
    } else {
      els.rateVal.textContent = prefs.speed.toFixed(1) + 'x';
      els.pitchVal.textContent = prefs.pitch.toFixed(1);
    }
  }

  // ------------------------------------------------------------
  // status polling
  // ------------------------------------------------------------
  async function refreshStatus() {
    const res = await sendMsg({ type: 'ttsr-status' });
    if (!res) {
      // Content script unreachable. If the tab is itself a PDF or one of our
      // reader pages, that's expected — point at the PDF banner instead of
      // claiming the page is broken.
      const tabUrl = (activeTab && activeTab.url) || '';
      const isReaderPage = tabUrl.indexOf(api.runtime.getURL('')) === 0;
      if (isPdfUrl(tabUrl) || isReaderPage) {
        hideError();
        els.status.textContent = 'no readable web page here — use the PDF reader or open a novel page';
        return;
      }
      showError("Can't reach this page — reload the tab, then reopen this popup.");
      return;
    }
    hideError();
    setPlayBtn(
      (res.isPlaying && !res.isPaused) ? ICON_PAUSE_PATH : ICON_PLAY_PATH,
      (res.isPlaying && !res.isPaused) ? 'Pause' : 'Play'
    );
    els.status.textContent = res.total
      ? 'sentence ' + (res.currentIndex + 1) + ' / ' + res.total
      : 'not started — press play to detect and read this page';
  }

  // ------------------------------------------------------------
  // events
  // ------------------------------------------------------------
  els.playPause.addEventListener('click', async () => {
    const st = await sendMsg({ type: 'ttsr-status' });
    if (st && st.isPlaying && !st.isPaused) {
      await sendMsg({ type: 'ttsr-pause' });
    } else {
      const res = await sendMsg({
        type: 'ttsr-play',
        engine: prefs.engine,
        voice: prefs.voice,
        speed: prefs.speed,
        pitch: prefs.pitch,
      });
      if (res && res.ok === false && res.reason === 'no-content') {
        showError("Couldn't find readable text on this page.");
      }
    }
    refreshStatus();
  });

  els.stop.addEventListener('click', async () => { await sendMsg({ type: 'ttsr-stop' }); refreshStatus(); });
  els.prev.addEventListener('click', async () => { await sendMsg({ type: 'ttsr-prev' }); refreshStatus(); });
  els.next.addEventListener('click', async () => { await sendMsg({ type: 'ttsr-next' }); refreshStatus(); });

  els.pdfOpen.addEventListener('click', async () => {
    if (!pdfTarget) return;
    const q = new URLSearchParams({ src: pdfTarget.url, tab: String(pdfTarget.tabId || '') });
    const reader = api.runtime.getURL('pdfviewer.html?' + q.toString());
    await api.tabs.create({ url: reader });
  });

  els.rate.addEventListener('input', () => {
    prefs.speed = parseFloat(els.rate.value);
    els.rateVal.textContent = prefs.engine === 'gfree' ? 'n/a' : prefs.speed.toFixed(1) + 'x';
    savePrefs();
  });
  els.pitch.addEventListener('input', () => {
    prefs.pitch = parseFloat(els.pitch.value);
    els.pitchVal.textContent = (prefs.engine === 'gfree' || prefs.engine === 'kokoro') ? 'n/a' : prefs.pitch.toFixed(1);
    savePrefs();
  });

  els.engine.addEventListener('change', () => {
    prefs.engine = els.engine.value;
    prefs.voice = ''; // reset; each engine has different voice ids
    savePrefs();
    rebuildVoiceList();
  });

  els.piperRecheck.addEventListener('click', async () => {
    await refreshPiperSetup();
    await rebuildVoiceList();
  });

  // When user selects from datalist, the text input holds the option value
  // (the voice id). Map it back, stash in hidden #voice, save prefs.
  // Firefox fires only 'input' (not 'change') for datalist picks — 'change'
  // arrives on blur/Enter — so an exact match commits at once on input.
  // Deletion events only filter, so backspacing can never mis-commit.
  function commitVoiceSelection() {
    const typed = els.voiceSearch.value.trim();
    const match = voiceList.find((v) => v.label === typed || v.id === typed);
    const id = match ? match.id : '';
    if (id) {
      els.voice.value = id;
      prefs.voice = id;
      savePrefs();
    }
  }
  els.voiceSearch.addEventListener('input', (e) => {
    const typed = (els.voiceSearch.value || '').trim();
    const exact = voiceList.find((v) => v.label === typed || v.id === typed);
    const isDelete = e && e.inputType && e.inputType.indexOf('delete') === 0;
    if (exact && !isDelete) {
      commitVoiceSelection();
      return;
    }
    renderVoiceSelect(typed.toLowerCase());
  });
  els.voiceSearch.addEventListener('change', commitVoiceSelection);

  els.gcloudSave.addEventListener('click', async () => {
    const k = els.gcloudKey.value.trim();
    if (!k) { els.gcloudKeyStatus.textContent = 'paste a key first'; els.gcloudKeyStatus.className = 'value bad'; return; }
    els.gcloudKeyStatus.textContent = 'testing…'; els.gcloudKeyStatus.className = 'value';
    // Validate BEFORE persisting (the candidate key travels in the message):
    // the old code stored first and pinged the stored key afterwards — a typo
    // silently overwrote a working key, and "✓ key works" only meant "a key
    // is present". Now only a key Google actually accepts is stored.
    const res = await bgSend({ type: 'ttsr-gcloud-ping', key: k });
    if (res && res.ok) {
      await api.storage.local.set({ ttsr_gcloud_key: k });
      els.gcloudKeyStatus.textContent = '✓ key works'; els.gcloudKeyStatus.className = 'value ok';
      gcloudVoices = null; // force re-fetch
      if (prefs.engine === 'gcloud') rebuildVoiceList();
    } else {
      els.gcloudKeyStatus.textContent = '✗ ' + ((res && res.error) || 'failed');
      els.gcloudKeyStatus.className = 'value bad';
    }
  });

  // Native voices may arrive async.
  if (typeof speechSynthesis !== 'undefined') {
    speechSynthesis.onvoiceschanged = () => { if (prefs.engine === 'system') rebuildVoiceList(); };
  }

  async function init() {
    try {
      const tab = await getActiveTab();
      if (!tab) { showError('No active tab found.'); return; }
      activeTabId = tab.id;
      activeTab = tab;
      await loadPrefs();
      await rebuildVoiceList();
      // Sync search input to show selected voice on reopen
      const val = prefs.voice;
      if (val) {
        const match = voiceList.find(v => v.id === val);
        if (match) els.voiceSearch.value = match.label;
      }
      await refreshStatus();
      await refreshPdfInfo();
      statusTimer = setInterval(refreshStatus, 1000);
    } catch (e) {
      showError('Failed to initialize — reopen popup to retry.');
    }
  }
  init();

  window.addEventListener('unload', () => { if (statusTimer) clearInterval(statusTimer); });
})();
