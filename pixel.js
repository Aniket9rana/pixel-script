(function (window, document) {
  "use strict";

  // ─── VERSION ────────────────────────────────────────────────────────────────
  var SDK_VERSION = "1.0.0";

  // ─── CONFIG ─────────────────────────────────────────────────────────────────
  // Defaults — overridden by window.PIXEL_CONFIG or PixelScript.init()
  var config = {
    endpoint:         "",
    siteId:           "",
    trackScrollDepth: true,
    trackOutbound:    true,
    trackForms:       true,
    sessionTimeout:   30 * 60 * 1000,
    debug:            false,
  };

  // Merge window.PIXEL_CONFIG immediately so it's available before init
  if (window.PIXEL_CONFIG && typeof window.PIXEL_CONFIG === "object") {
    Object.keys(window.PIXEL_CONFIG).forEach(function (k) {
      config[k] = window.PIXEL_CONFIG[k];
    });
  }

  // ─── STATE ──────────────────────────────────────────────────────────────────
  var consentGranted = false;
  var offlineBuffer = [];
  var scrollDepthsFired = {};
  var utmData = {};
  var sessionTimer = null;

  // ─── UTILS ──────────────────────────────────────────────────────────────────
  function uuidv4() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function log() {
    if (config.debug) {
      console.log.apply(console, ["[PixelScript]"].concat(Array.prototype.slice.call(arguments)));
    }
  }

  function safeGet(fn) {
    try { return fn(); } catch (e) { return null; }
  }

  function safeSet(fn) {
    try { fn(); } catch (e) {}
  }

  // ─── STORAGE ────────────────────────────────────────────────────────────────
  var store = {
    get: function (key) {
      return safeGet(function () { return localStorage.getItem(key); });
    },
    set: function (key, val) {
      safeSet(function () { localStorage.setItem(key, val); });
    },
    session: {
      get: function (key) {
        return safeGet(function () { return sessionStorage.getItem(key); });
      },
      set: function (key, val) {
        safeSet(function () { sessionStorage.setItem(key, val); });
      },
    },
  };

  // ─── COOKIE FALLBACK (Safari ITP) ───────────────────────────────────────────
  // Used only when localStorage is unavailable
  function getCookie(name) {
    var match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function setCookie(name, value, days) {
    var expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = name + "=" + encodeURIComponent(value) + "; expires=" + expires + "; path=/; SameSite=Lax";
  }

  // ─── IDENTITY ───────────────────────────────────────────────────────────────
  function getAnonId() {
    var key = "ps_anon_id";
    var id = store.get(key) || getCookie(key);
    if (!id) {
      id = uuidv4();
      store.set(key, id);
      setCookie(key, id, 365);
    }
    return id;
  }

  function getSessionId() {
    var key = "ps_session_id";
    var tsKey = "ps_session_ts";
    var now = Date.now();
    var id = store.session.get(key);
    var lastTs = parseInt(store.session.get(tsKey) || "0", 10);

    if (!id || now - lastTs > config.sessionTimeout) {
      id = uuidv4();
      store.session.set(key, id);
      log("New session:", id);
    }
    store.session.set(tsKey, String(now));
    resetSessionTimer();
    return id;
  }

  function resetSessionTimer() {
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(function () {
      store.session.set("ps_session_id", uuidv4());
      store.session.set("ps_session_ts", String(Date.now()));
      log("Session expired, new session created");
    }, config.sessionTimeout);
  }

  // ─── ATTRIBUTION CAPTURE ────────────────────────────────────────────────────
  // All UTM params + every major ad-network click ID
  var ATTRIBUTION_KEYS = [
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "fbclid",   // Meta / Facebook
    "gclid",    // Google Ads
    "ttclid",   // TikTok
    "msclkid",  // Microsoft / Bing
    "twclid",   // Twitter / X
    "li_fat_id",// LinkedIn
    "igshid",   // Instagram
    "ScCid",    // Snapchat
  ];

  function captureUTMs() {
    var params = new URLSearchParams(window.location.search);
    var captured = {};

    ATTRIBUTION_KEYS.forEach(function (k) {
      var v = params.get(k);
      if (v) captured[k] = v;
    });

    // Meta browser/click ID cookies (_fbp set by fbevents.js, _fbc from fbclid)
    var fbp = getCookie("_fbp");
    var fbc = getCookie("_fbc");
    if (fbp) captured._fbp = fbp;
    // Build _fbc from fbclid if Meta hasn't set it yet
    if (!fbc && captured.fbclid) {
      captured._fbc = "fb.1." + Date.now() + "." + captured.fbclid;
    } else if (fbc) {
      captured._fbc = fbc;
    }

    if (Object.keys(captured).length) {
      // Last touch — always overwrite per session
      store.session.set("ps_last_touch", JSON.stringify(captured));

      // First touch — only write once, persists across sessions
      if (!store.get("ps_first_touch")) {
        store.set("ps_first_touch", JSON.stringify(captured));
        log("First touch captured:", captured);
      }

      log("Last touch captured:", captured);
    }

    // Merge first + last touch into utmData for payload attachment
    var firstTouch = store.get("ps_first_touch");
    var lastTouch  = store.session.get("ps_last_touch");
    utmData = {
      first_touch: firstTouch ? JSON.parse(firstTouch) : null,
      last_touch:  lastTouch  ? JSON.parse(lastTouch)  : null,
    };
  }

  // ─── PAYLOAD BUILDER ────────────────────────────────────────────────────────
  function buildPayload(eventName, properties) {
    return {
      event_id:    uuidv4(),
      event_name:  eventName,
      site_id:     config.siteId,
      anon_id:     getAnonId(),
      session_id:  getSessionId(),
      page_url:    window.location.href,
      page_path:   window.location.pathname,
      referrer:    document.referrer || null,
      attribution: {
        first_touch: utmData.first_touch || null,
        last_touch:  utmData.last_touch  || null,
      },
      properties:  properties || {},
      consent:     consentGranted ? "granted" : "pending",
      sdk_version: SDK_VERSION,
      timestamp:   new Date().toISOString(),
    };
  }

  // ─── DELIVERY ───────────────────────────────────────────────────────────────
  function sendPayload(payload) {
    if (!config.endpoint) {
      log("No endpoint configured, dropping event:", payload.event_name);
      return;
    }

    if (!consentGranted) {
      offlineBuffer.push(payload);
      log("Consent pending, buffered:", payload.event_name);
      return;
    }

    var body = JSON.stringify(payload);

    // sendBeacon primary — survives tab close
    if (navigator.sendBeacon) {
      var blob = new Blob([body], { type: "application/json" });
      var sent = navigator.sendBeacon(config.endpoint, blob);
      if (sent) {
        log("Beacon sent:", payload.event_name);
        return;
      }
    }

    // fetch fallback
    fetch(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SDK-Version": SDK_VERSION },
      body: body,
      keepalive: true,
    }).catch(function () {
      // offline — buffer for retry
      offlineBuffer.push(payload);
      store.set("ps_offline_buffer", JSON.stringify(offlineBuffer));
      log("Offline, buffered:", payload.event_name);
    });
  }

  function track(eventName, properties) {
    var payload = buildPayload(eventName, properties);
    log("Track:", eventName, properties);
    sendPayload(payload);
  }

  // ─── OFFLINE RETRY ──────────────────────────────────────────────────────────
  function flushOfflineBuffer() {
    var stored = store.get("ps_offline_buffer");
    if (stored) {
      try {
        var events = JSON.parse(stored);
        events.forEach(function (payload) { sendPayload(payload); });
        store.set("ps_offline_buffer", "[]");
        log("Flushed offline buffer:", events.length, "events");
      } catch (e) {}
    }
    if (offlineBuffer.length) {
      offlineBuffer.forEach(function (payload) { sendPayload(payload); });
      offlineBuffer = [];
    }
  }

  window.addEventListener("online", flushOfflineBuffer);

  // ─── CONSENT BUFFER FLUSH ───────────────────────────────────────────────────
  function flushConsentBuffer() {
    var buf = offlineBuffer.slice();
    offlineBuffer = [];
    buf.forEach(function (payload) {
      payload.consent = "granted";
      sendPayload(payload);
    });
    log("Consent granted, flushed buffer:", buf.length, "events");
  }

  // ─── PAGE VIEW ──────────────────────────────────────────────────────────────
  function trackPageView() {
    scrollDepthsFired = {}; // reset scroll depth on new page
    track("page_view", {
      title: document.title,
      screen_width: window.screen.width,
      screen_height: window.screen.height,
    });
  }

  // SPA route change — patch history API
  function patchHistory() {
    var orig = history.pushState;
    history.pushState = function () {
      orig.apply(history, arguments);
      captureUTMs();
      trackPageView();
    };
    window.addEventListener("popstate", function () {
      captureUTMs();
      trackPageView();
    });
  }

  // ─── CLICK TRACKING ─────────────────────────────────────────────────────────
  function getClosestTrackable(el) {
    var node = el;
    while (node && node !== document.body) {
      if (node.tagName) {
        var tag = node.tagName.toLowerCase();
        if (tag === "a" || tag === "button" || node.dataset.track) return node;
      }
      node = node.parentElement;
    }
    return el;
  }

  function isOutbound(el) {
    if (el.tagName && el.tagName.toLowerCase() === "a") {
      var href = el.getAttribute("href") || "";
      return href.indexOf("http") === 0 && href.indexOf(window.location.hostname) === -1;
    }
    return false;
  }

  function initClickTracking() {
    document.addEventListener("click", function (e) {
      var el = getClosestTrackable(e.target);
      if (!el) return;

      var tag = (el.tagName || "").toLowerCase();
      var text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 100);
      var trackAttr = el.dataset ? el.dataset.track : null;
      var href = el.getAttribute ? el.getAttribute("href") : null;

      var props = {
        tag: tag,
        text: text,
        id: el.id || null,
        class: (el.className && typeof el.className === "string") ? el.className.split(" ")[0] : null,
        track_attr: trackAttr || null,
      };

      if (config.trackOutbound && isOutbound(el)) {
        props.outbound_url = href;
        track("outbound_click", props);
        log("Outbound click:", href);
        return;
      }

      if (trackAttr) {
        // Standard events → fbq("track", ...), custom events → fbq("trackCustom", ...)
        // trackMetaEvent handles both via fireFbq internally
        trackMetaEvent(trackAttr, props);
      } else {
        track("click", props);
      }
    }, true);
  }

  // ─── FORM TRACKING ──────────────────────────────────────────────────────────
  function initFormTracking() {
    if (!config.trackForms) return;

    document.addEventListener("submit", function (e) {
      var form = e.target;
      var fields = [];
      // capture field names only — never values
      Array.prototype.forEach.call(form.elements, function (el) {
        if (el.name && el.type !== "hidden" && el.type !== "password") {
          fields.push(el.name);
        }
      });

      var formProps = {
        form_id:     form.id || null,
        form_name:   form.getAttribute("name") || null,
        form_action: form.getAttribute("action") || null,
        fields:      fields,
      };

      // data-track-form="Lead" (or any Meta Standard Event) fires that event too
      var metaFormEvent = form.dataset ? form.dataset.trackForm : null;
      if (metaFormEvent && META_STANDARD_EVENTS[metaFormEvent]) {
        trackMetaEvent(metaFormEvent, formProps);
      } else {
        track("form_submit", formProps);
      }
    }, true);

    // track form field focus (engagement signal)
    document.addEventListener("focusin", function (e) {
      var el = e.target;
      if (el.tagName && (el.tagName.toLowerCase() === "input" || el.tagName.toLowerCase() === "textarea") && el.type !== "password") {
        track("form_field_focus", {
          field_name: el.name || null,
          field_type: el.type || null,
          form_id: el.form ? el.form.id : null,
        });
      }
    }, true);
  }

  // ─── SCROLL DEPTH ───────────────────────────────────────────────────────────
  function initScrollTracking() {
    if (!config.trackScrollDepth) return;

    var thresholds = [25, 50, 75, 100];
    var ticking = false;

    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        var scrollTop = window.scrollY || document.documentElement.scrollTop;
        var docHeight = Math.max(
          document.body.scrollHeight, document.documentElement.scrollHeight,
          document.body.offsetHeight, document.documentElement.offsetHeight
        ) - window.innerHeight;

        if (docHeight <= 0) { ticking = false; return; }

        var pct = Math.round((scrollTop / docHeight) * 100);

        thresholds.forEach(function (t) {
          if (pct >= t && !scrollDepthsFired[t]) {
            scrollDepthsFired[t] = true;
            track("scroll_depth", { depth_percent: t });
          }
        });
        ticking = false;
      });
    }

    window.addEventListener("scroll", onScroll, { passive: true });
  }

  // ─── SESSION LIFECYCLE ──────────────────────────────────────────────────────
  function initSessionTracking() {
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") {
        track("page_hidden", { page_path: window.location.pathname });
      } else {
        track("page_visible", { page_path: window.location.pathname });
      }
    });

    window.addEventListener("beforeunload", function () {
      track("page_exit", { page_path: window.location.pathname });
    });
  }

  // ─── META STANDARD EVENTS ───────────────────────────────────────────────────
  // Full list of Meta Standard Event names for validation
  var META_STANDARD_EVENTS = {
    ViewContent:          true,
    AddToCart:            true,
    AddToWishlist:        true,
    InitiateCheckout:     true,
    AddPaymentInfo:       true,
    Purchase:             true,
    Lead:                 true,
    CompleteRegistration: true,
    Search:               true,
    Contact:              true,
    CustomizeProduct:     true,
    Donate:               true,
    FindLocation:         true,
    Schedule:             true,
    StartTrial:           true,
    SubmitApplication:    true,
    Subscribe:            true,
  };

  // Fire to Meta browser pixel (fbq) if the base code is on the page
  function fireFbq(eventName, params) {
    if (typeof window.fbq === "function") {
      if (META_STANDARD_EVENTS[eventName]) {
        window.fbq("track", eventName, params || {});
      } else {
        window.fbq("trackCustom", eventName, params || {});
      }
      log("fbq fired:", eventName, params);
    }
  }

  // Central Meta event dispatcher — sends to pixel endpoint + fbq simultaneously
  function trackMetaEvent(eventName, properties) {
    track(eventName, properties);
    fireFbq(eventName, properties);
  }

  // Auto-detect ViewContent from data-track-content attribute on page elements
  function autoDetectViewContent() {
    var el = document.querySelector("[data-track-content]");
    if (el) {
      var props = {
        content_name:     el.getAttribute("data-content-name")     || document.title,
        content_category: el.getAttribute("data-content-category") || null,
        content_ids:      el.getAttribute("data-content-ids")      || null,
        content_type:     el.getAttribute("data-content-type")     || "product",
        value:            parseFloat(el.getAttribute("data-value")) || null,
        currency:         el.getAttribute("data-currency")         || null,
      };
      // Remove null fields
      Object.keys(props).forEach(function (k) { if (props[k] === null) delete props[k]; });
      trackMetaEvent("ViewContent", props);
    }
  }

  // ─── PUBLIC API ─────────────────────────────────────────────────────────────
  var PixelScript = {
    init: function (userConfig) {
      Object.keys(userConfig).forEach(function (k) {
        config[k] = userConfig[k];
      });

      captureUTMs();
      patchHistory();
      initClickTracking();
      initFormTracking();
      initScrollTracking();
      initSessionTracking();
      flushOfflineBuffer();

      trackPageView();
      autoDetectViewContent();
      log("Initialized. Site:", config.siteId, "| Endpoint:", config.endpoint);
    },

    // Call this from your CMP when consent is granted
    setConsent: function (status) {
      consentGranted = status === "granted";
      if (consentGranted) flushConsentBuffer();
      log("Consent set to:", status);
    },

    // Generic event — goes to pixel endpoint only
    track: track,

    // Meta Standard Event — goes to pixel endpoint + fbq()
    trackMetaEvent: trackMetaEvent,

    // Shorthand helpers for the most common conversion events
    trackPurchase: function (props) {
      // props: { value, currency, order_id, content_ids, contents }
      trackMetaEvent("Purchase", props || {});
    },
    trackLead: function (props) {
      trackMetaEvent("Lead", props || {});
    },
    trackAddToCart: function (props) {
      // props: { content_id, content_name, value, currency }
      trackMetaEvent("AddToCart", props || {});
    },
    trackInitiateCheckout: function (props) {
      trackMetaEvent("InitiateCheckout", props || {});
    },
    trackCompleteRegistration: function (props) {
      trackMetaEvent("CompleteRegistration", props || {});
    },
    trackViewContent: function (props) {
      trackMetaEvent("ViewContent", props || {});
    },

    // Identify a logged-in user — stitches anon_id → user_id
    identify: function (userId, traits) {
      track("identify", Object.assign({ user_id: userId }, traits || {}));
      log("Identify:", userId);
    },
  };

  window.PixelScript = PixelScript;

  // ─── SELF-INIT ───────────────────────────────────────────────────────────────
  // Auto-initializes when window.PIXEL_CONFIG is present — no manual init() call needed.
  // Manual PixelScript.init() call still works and takes precedence.
  if (window.PIXEL_CONFIG) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        PixelScript.init(config);
      });
    } else {
      // DOM already ready (script loaded async/defer or after DOMContentLoaded)
      PixelScript.init(config);
    }
  }
})(window, document);
