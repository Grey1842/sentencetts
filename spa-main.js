// SentenceTTS Reader — SPA page-world navigation tripwire.
//
// WHY A SEPARATE FILE: on a Next.js pages-router site like novelbuddy.me,
// chapter navigation is `router.push` + an in-place article swap — the page's
// OWN History.prototype.pushState call, in the page's MAIN world. Wrappers
// installed on the content script's `history` object live in an isolated
// world (Firefox Xray / Chrome isolated world) and can NEVER see those calls.
// content.js therefore installs a patch in the page world that reports back
// through a `ttsr-spa-nav` DOM event (the DOM is shared across worlds).
//
// It used to inject that patch as an inline <script> from content.js, but
// Chrome MV3 evaluates content-script-injected inline scripts against the
// EXTENSION's content_security_policy (script-src 'self' — no 'unsafe-inline',
// verified in Chromium 153: "Executing inline script violates the following
// Content Security Policy directive ..." attributed to content.js), so the
// inline injection was silently CSP-blocked on EVERY site in Chrome. Declaring
// this file as a "world": "MAIN" content script lets the BROWSER load it —
// no DOM injection, no CSP surface. world:MAIN needs Chrome 111+/FF 128+;
// both are far below the manifest's minimums (strict_min_version 140,
// gecko_android 142, minimum_chrome_version 119).
//
// The listener side (document 'ttsr-spa-nav' -> onLikelyNav) lives in
// content.js. Keep this file minimal and side-effect-free otherwise: it runs
// before page scripts, on every site, at document_start.
(function () {
  'use strict';
  if (window.__ttsrSpaMainPatch) return;
  window.__ttsrSpaMainPatch = true;
  try {
    var push = History.prototype.pushState;
    var replace = History.prototype.replaceState;
    function report() {
      try {
        document.dispatchEvent(new CustomEvent('ttsr-spa-nav', {
          detail: { src: 'sentencetts', url: location.href },
        }));
      } catch (e) {}
    }
    History.prototype.pushState = function () {
      try { return push.apply(this, arguments); }
      finally { report(); }
    };
    History.prototype.replaceState = function () {
      try { return replace.apply(this, arguments); }
      finally { report(); }
    };
  } catch (e) {}
})();
