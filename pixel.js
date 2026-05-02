(function (window, document) {
  "use strict";

  // ─── VERSION ────────────────────────────────────────────────────────────────
  var SDK_VERSION = "1.3.0";

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
  var lastMetaEventName = null;
  var lastMetaEventTs = 0;

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
  // Capture all utm* params, clid/click_id params, and common ad click IDs
  // that do not use a "clid" suffix.
  var EXTRA_ATTRIBUTION_KEYS = {
    dclid: true,
    gbraid: true,
    igshid: true,
    li_fat_id: true,
    mc_cid: true,
    mc_eid: true,
    sccid: true,
    wbraid: true,
    yclid: true,
  };

  function normalizeAttributionKey(key) {
    return String(key || "").toLowerCase();
  }

  function isAttributionKey(key) {
    var normalized = normalizeAttributionKey(key);
    return normalized.indexOf("utm") === 0 ||
      normalized.indexOf("clid") !== -1 ||
      normalized.indexOf("click_id") !== -1 ||
      !!EXTRA_ATTRIBUTION_KEYS[normalized];
  }

  function captureUTMs() {
    var params = new URLSearchParams(window.location.search);
    var captured = {};

    params.forEach(function (v, k) {
      if (v && isAttributionKey(k)) {
        captured[normalizeAttributionKey(k)] = v;
      }
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
  function getStoredMetaSignal(key) {
    return getCookie(key) ||
      (utmData.last_touch && utmData.last_touch[key]) ||
      (utmData.first_touch && utmData.first_touch[key]) ||
      null;
  }

  function getProvidedEventId(properties, options) {
    if (typeof options === "string") return options;
    if (options && (options.eventId || options.event_id)) {
      return options.eventId || options.event_id;
    }
    if (properties && typeof properties === "object" && (properties.event_id || properties.eventId)) {
      return properties.event_id || properties.eventId;
    }
    return uuidv4();
  }

  function cleanEventProperties(properties) {
    var cleaned = {};
    if (!properties || typeof properties !== "object") return cleaned;

    Object.keys(properties).forEach(function (k) {
      if (k === "event_id" || k === "eventId") return;
      cleaned[k] = properties[k];
    });
    return cleaned;
  }

  function buildPayload(eventName, properties, options) {
    var cleanProperties = cleanEventProperties(properties);

    return {
      event_id:    getProvidedEventId(properties, options),
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
      fbp:         getStoredMetaSignal("_fbp"),
      fbc:         getStoredMetaSignal("_fbc"),
      properties:  cleanProperties,
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

  function track(eventName, properties, options) {
    var payload = buildPayload(eventName, properties, options);
    log("Track:", eventName, properties);
    sendPayload(payload);
    return payload;
  }

  // ─── OFFLINE RETRY ──────────────────────────────────────────────────────────
  function flushOfflineBuffer() {
    var pending = [];
    var seen = {};

    function addPending(payload) {
      if (!payload) return;
      var key = payload.event_id || JSON.stringify(payload);
      if (seen[key]) return;
      seen[key] = true;
      pending.push(payload);
    }

    var stored = store.get("ps_offline_buffer");
    if (stored) {
      try {
        var events = JSON.parse(stored);
        if (Array.isArray(events)) {
          events.forEach(addPending);
        }
      } catch (e) {}
      store.set("ps_offline_buffer", "[]");
    }

    if (offlineBuffer.length) {
      offlineBuffer.forEach(addPending);
      offlineBuffer = [];
    }

    if (pending.length) {
      pending.forEach(function (payload) { sendPayload(payload); });
      log("Flushed offline buffer:", pending.length, "events");
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

  // ─── PAYMENT AMOUNT EXTRACTION ──────────────────────────────────────────────
  var CURRENCY_SYMBOLS = { '₹': 'INR', '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
  function extractPaymentProps(text) {
    for (var symbol in CURRENCY_SYMBOLS) {
      var re = new RegExp('[' + symbol + ']([\\d,]+(?:\\.\\d+)?)');
      var match = text.match(re);
      if (match) {
        return { value: parseFloat(match[1].replace(/,/g, '')), currency: CURRENCY_SYMBOLS[symbol] };
      }
    }
    return {};
  }

  // ─── SMART EVENT DETECTION ──────────────────────────────────────────────────
  var CLICK_EVENT_PATTERNS = [
    { re: /add.to.cart|add.to.bag|add.to.basket|go.to.bag|go.to.cart/i,  event: "AddToCart" },
    { re: /place.order|confirm.order|complete.purchase|pay.now|pay\s*[₹$€£¥]|pay\s+\d/i, event: "Purchase" },
    { re: /buy.now|proceed.to.checkout|go.to.checkout/i,                 event: "InitiateCheckout" },
    { re: /add.to.wishlist|save.for.later|add.to.favorites/i,            event: "AddToWishlist" },
    { re: /start.*(free.)?trial|try.for.free/i,                          event: "StartTrial" },
    { re: /book.appointment|book.a.call|book.a.demo|book.now|schedule/i, event: "Schedule" },
    { re: /donate|make.a.donation/i,                                     event: "Donate" },
    { re: /contact.us|get.in.touch|send.message/i,                       event: "Contact" },
    { re: /subscribe|join.newsletter|sign.up.for/i,                      event: "Subscribe" },
    { re: /get.started|sign.up|create.account|join.now|request.demo/i,   event: "Lead" },
  ];

  var URL_EVENT_PATTERNS = [
    { re: /\/(order-confirmation|thank.you|order-success|success)/i, event: "Purchase" },
    { re: /\/checkout/i,                                              event: "InitiateCheckout" },
    { re: /\/cart/i,                                                  event: "AddToCart" },
    { re: /\/(product|products)\//i,                                  event: "ViewContent" },
    { re: /\/search/i,                                                event: "Search" },
  ];

  var FORM_EVENT_PATTERNS = [
    { re: /checkout|payment|order/i,          event: "Purchase" },
    { re: /register|signup|sign.up|create/i,  event: "CompleteRegistration" },
    { re: /contact|inquiry|message/i,         event: "Contact" },
    { re: /lead|quote|demo|trial|newsletter/i, event: "Lead" },
  ];

  function detectClickEvent(text) {
    if (!text) return null;
    for (var i = 0; i < CLICK_EVENT_PATTERNS.length; i++) {
      if (CLICK_EVENT_PATTERNS[i].re.test(text)) return CLICK_EVENT_PATTERNS[i].event;
    }
    return null;
  }

  function detectUrlEvent(path) {
    for (var i = 0; i < URL_EVENT_PATTERNS.length; i++) {
      if (URL_EVENT_PATTERNS[i].re.test(path)) return URL_EVENT_PATTERNS[i].event;
    }
    return null;
  }

  function detectFormEvent(form) {
    var combined = [form.id, form.getAttribute("name"), form.getAttribute("action")].join(" ").toLowerCase();
    for (var i = 0; i < FORM_EVENT_PATTERNS.length; i++) {
      if (FORM_EVENT_PATTERNS[i].re.test(combined)) return FORM_EVENT_PATTERNS[i].event;
    }
    return null;
  }

  // ─── PAGE VIEW ──────────────────────────────────────────────────────────────
  function trackPageView() {
    scrollDepthsFired = {};
    var props = {
      title: document.title,
      screen_width: window.screen.width,
      screen_height: window.screen.height,
    };
    track("page_view", props);

    // Auto-fire URL-based Meta Standard Event on page load
    var urlEvent = detectUrlEvent(window.location.pathname);
    if (urlEvent) {
      trackMetaEvent(urlEvent, { page_path: window.location.pathname });
    }
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
        if (tag === "a" || tag === "button" || tag === "input" || node.dataset.track) return node;
      }
      node = node.parentElement;
    }
    // Only return the fallback element if it's actually interactive
    var t = el && (el.tagName || "").toLowerCase();
    return (t === "a" || t === "button" || t === "input") ? el : null;
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
      var isValueButton = tag === "input" && (el.type === "submit" || el.type === "button" || el.type === "reset");
      var rawText = (el.innerText || (isValueButton ? el.value : "") || el.getAttribute("aria-label") || "").trim().slice(0, 100);
      // Suppress text that looks like a phone number — avoids storing PII as click label
      var text = /^\+?[\d\s\-().]{7,}$/.test(rawText) ? "" : rawText;
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
        trackMetaEvent(trackAttr, props);
      } else {
        var detectedEvent = detectClickEvent(text);
        if (detectedEvent) {
          if (detectedEvent === "Purchase") {
            var payProps = extractPaymentProps(text);
            if (payProps.value) Object.assign(props, payProps);
          }
          trackMetaEvent(detectedEvent, props);
        } else {
          track("click", props);
        }
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

      var metaFormEvent = (form.dataset && form.dataset.trackForm) || detectFormEvent(form);
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
  function fireFbq(eventName, params, eventId) {
    if (typeof window.fbq === "function") {
      var fbqOptions = eventId ? { eventID: eventId } : undefined;
      if (META_STANDARD_EVENTS[eventName]) {
        if (fbqOptions) {
          window.fbq("track", eventName, params || {}, fbqOptions);
        } else {
          window.fbq("track", eventName, params || {});
        }
      } else {
        if (fbqOptions) {
          window.fbq("trackCustom", eventName, params || {}, fbqOptions);
        } else {
          window.fbq("trackCustom", eventName, params || {});
        }
      }
      log("fbq fired:", eventName, params, fbqOptions || {});
    }
  }

  // Central Meta event dispatcher — sends to pixel endpoint + fbq simultaneously
  function trackMetaEvent(eventName, properties, options) {
    // Deduplicate same event fired within 300ms — prevents double-fire when
    // multiple buttons with identical text exist on the same page
    var now = Date.now();
    if (eventName === lastMetaEventName && now - lastMetaEventTs < 1500) {
      log("Deduped rapid duplicate:", eventName);
      return;
    }
    lastMetaEventName = eventName;
    lastMetaEventTs = now;

    var payload = buildPayload(eventName, properties, options);
    payload.meta_event = true;
    sendPayload(payload);
    fireFbq(eventName, payload.properties, payload.event_id);
    return payload;
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
      userConfig = userConfig || {};
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

    createEventId: uuidv4,

    // Shorthand helpers for the most common conversion events
    trackPurchase: function (props, options) {
      // props: { value, currency, order_id, content_ids, contents }
      return trackMetaEvent("Purchase", props || {}, options);
    },
    trackLead: function (props, options) {
      return trackMetaEvent("Lead", props || {}, options);
    },
    trackAddToCart: function (props, options) {
      // props: { content_id, content_name, value, currency }
      return trackMetaEvent("AddToCart", props || {}, options);
    },
    trackInitiateCheckout: function (props, options) {
      return trackMetaEvent("InitiateCheckout", props || {}, options);
    },
    trackCompleteRegistration: function (props, options) {
      return trackMetaEvent("CompleteRegistration", props || {}, options);
    },
    trackViewContent: function (props, options) {
      return trackMetaEvent("ViewContent", props || {}, options);
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
