"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const pixelSource = fs.readFileSync(path.join(__dirname, "pixel.js"), "utf8");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeStorage(initial = {}) {
  const data = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    clear() {
      data.clear();
    },
    dump() {
      return Object.fromEntries(data.entries());
    },
  };
}

function makeFailingStorage() {
  return {
    getItem() {
      throw new Error("storage unavailable");
    },
    setItem() {
      throw new Error("storage unavailable");
    },
    removeItem() {
      throw new Error("storage unavailable");
    },
  };
}

function addEventTarget(target) {
  const listeners = {};
  target.addEventListener = function addEventListener(type, listener) {
    if (!listeners[type]) listeners[type] = [];
    listeners[type].push(listener);
  };
  target.dispatchEvent = function dispatchEvent(event) {
    const evt = typeof event === "string" ? { type: event } : event;
    if (!evt.target) evt.target = target;
    (listeners[evt.type] || []).slice().forEach((listener) => listener.call(target, evt));
  };
  target.listeners = listeners;
}

function makeLocation(initialUrl) {
  const location = {};
  function set(url) {
    const parsed = new URL(url, location.href || initialUrl);
    location.href = parsed.href;
    location.search = parsed.search;
    location.pathname = parsed.pathname;
    location.hostname = parsed.hostname;
    location.origin = parsed.origin;
  }
  set(initialUrl);
  location.set = set;
  return location;
}

function makeElement(tagName, options = {}) {
  const attrs = { ...(options.attrs || {}) };
  const element = {
    tagName: tagName.toUpperCase(),
    id: options.id || "",
    className: options.className || "",
    innerText: options.innerText || "",
    value: options.value || "",
    name: options.name || "",
    type: options.type,
    dataset: { ...(options.dataset || {}) },
    elements: options.elements || [],
    parentElement: options.parentElement || null,
    form: options.form || null,
    getAttribute(name) {
      if (Object.prototype.hasOwnProperty.call(attrs, name)) return attrs[name];
      if (name === "href" && options.href) return options.href;
      if (name === "name" && options.name) return options.name;
      if (name === "action" && options.action) return options.action;
      return null;
    },
    setAttribute(name, value) {
      attrs[name] = String(value);
    },
  };

  if (options.href) attrs.href = options.href;
  if (options.action) attrs.action = options.action;
  if (options.name) attrs.name = options.name;

  return element;
}

function createHarness(options = {}) {
  const url = options.url || "https://shop.example/products";
  const localStorage = options.failingStorage ? makeFailingStorage() : makeStorage(options.localStorage);
  const sessionStorage = options.failingStorage ? makeFailingStorage() : makeStorage(options.sessionStorage);
  const location = makeLocation(url);
  const sent = { beacons: [], fetches: [] };
  const fbqCalls = [];
  const logs = [];
  const cookies = new Map(Object.entries(options.cookies || {}));
  let fetchImpl = options.fetchImpl || null;
  let timeoutId = 0;

  class FakeBlob {
    constructor(parts, blobOptions = {}) {
      this.parts = parts;
      this.type = blobOptions.type || "";
    }
  }

  function parseBody(body) {
    if (body instanceof FakeBlob) return JSON.parse(body.parts.join(""));
    if (typeof body === "string") return JSON.parse(body);
    throw new Error("Unsupported body type");
  }

  const navigator = {};
  if (!options.disableBeacon) {
    navigator.sendBeacon = function sendBeacon(endpoint, blob) {
      sent.beacons.push({ endpoint, payload: parseBody(blob) });
      return options.beaconReturn !== undefined ? options.beaconReturn : true;
    };
  }

  function fetchMock(endpoint, init) {
    const record = { endpoint, init, payload: parseBody(init.body) };
    sent.fetches.push(record);
    if (fetchImpl) return fetchImpl(endpoint, init, record);
    return Promise.resolve({
      ok: true,
      status: 202,
      json: async () => ({}),
      text: async () => "",
    });
  }

  const document = {
    readyState: options.readyState || "complete",
    title: options.title || "Pixel Test Product",
    referrer: options.referrer || "",
    visibilityState: "visible",
    body: makeElement("body"),
    documentElement: {
      scrollTop: 0,
      scrollHeight: options.docHeight || 1600,
      offsetHeight: options.docHeight || 1600,
    },
    querySelector(selector) {
      if (selector === "[data-track-content]") return options.trackContentElement || null;
      return null;
    },
  };
  addEventTarget(document);

  Object.defineProperty(document, "cookie", {
    get() {
      return Array.from(cookies.entries())
        .map(([key, value]) => `${key}=${value}`)
        .join("; ");
    },
    set(value) {
      const [pair] = String(value).split(";");
      const index = pair.indexOf("=");
      if (index === -1) return;
      cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    },
  });

  const history = {
    pushState(_state, _title, nextUrl) {
      if (nextUrl) location.set(nextUrl);
    },
  };

  const window = {
    document,
    location,
    history,
    navigator,
    localStorage,
    sessionStorage,
    screen: {
      width: options.screenWidth || 1440,
      height: options.screenHeight || 900,
    },
    innerHeight: options.innerHeight || 800,
    scrollY: options.scrollY || 0,
    console: {
      log(...args) {
        logs.push(args);
      },
    },
    fbq(...args) {
      fbqCalls.push(args);
    },
  };
  addEventTarget(window);
  if (options.config) window.PIXEL_CONFIG = options.config;

  const context = {
    window,
    document,
    history,
    navigator,
    localStorage,
    sessionStorage,
    location,
    Blob: FakeBlob,
    URL,
    URLSearchParams,
    fetch: fetchMock,
    requestAnimationFrame(callback) {
      callback();
    },
    setTimeout(_callback, _ms) {
      timeoutId += 1;
      return timeoutId;
    },
    clearTimeout() {},
    console: window.console,
  };
  context.globalThis = context;
  window.window = window;
  window.setFetchImpl = function setFetchImpl(nextFetchImpl) {
    fetchImpl = nextFetchImpl;
  };

  vm.createContext(context);
  vm.runInContext(pixelSource, context, { filename: "pixel.js" });

  return {
    context,
    window,
    document,
    history,
    location,
    localStorage,
    sessionStorage,
    cookies,
    sent,
    fbqCalls,
    logs,
    setFetchImpl(nextFetchImpl) {
      fetchImpl = nextFetchImpl;
    },
    clearDeliveries() {
      sent.beacons.length = 0;
      sent.fetches.length = 0;
      fbqCalls.length = 0;
    },
  };
}

function storedJson(storage, key) {
  const value = storage.getItem(key);
  return value ? JSON.parse(value) : null;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("self-init captures attribution and flushes buffered page view after consent", () => {
  const harness = createHarness({
    url: "https://shop.example/products?utm_source=meta&utm_medium=cpc&fbclid=FB123&UTM_Custom=creative&gbraid=GB123&partner_click_id=PCID&random=no",
    config: { endpoint: "https://tracker.example/event", siteId: "shop" },
    cookies: { _fbp: "fb.1.111.abc" },
  });

  assert.equal(harness.sent.beacons.length, 0);

  const firstTouch = storedJson(harness.localStorage, "ps_first_touch");
  const lastTouch = storedJson(harness.sessionStorage, "ps_last_touch");
  assert.equal(firstTouch.utm_source, "meta");
  assert.equal(firstTouch.utm_medium, "cpc");
  assert.equal(firstTouch.fbclid, "FB123");
  assert.equal(firstTouch.utm_custom, "creative");
  assert.equal(firstTouch.gbraid, "GB123");
  assert.equal(firstTouch.partner_click_id, "PCID");
  assert.equal(firstTouch.random, undefined);
  assert.equal(firstTouch._fbp, "fb.1.111.abc");
  assert.match(firstTouch._fbc, /^fb\.1\.\d+\.FB123$/);
  assert.deepEqual(lastTouch, firstTouch);

  harness.window.PixelScript.setConsent("granted");

  assert.equal(harness.sent.beacons.length, 1);
  const payload = harness.sent.beacons[0].payload;
  assert.equal(payload.event_name, "page_view");
  assert.equal(payload.site_id, "shop");
  assert.equal(payload.page_path, "/products");
  assert.equal(payload.consent, "granted");
  assert.equal(payload.fbp, "fb.1.111.abc");
  assert.match(payload.fbc, /^fb\.1\.\d+\.FB123$/);
  assert.match(payload.anon_id, UUID_RE);
  assert.match(payload.session_id, UUID_RE);
  assert.equal(payload.attribution.first_touch.utm_source, "meta");
  assert.equal(payload.attribution.last_touch.fbclid, "FB123");
  assert.equal(payload.attribution.last_touch.gbraid, "GB123");
});

test("manual init works when PIXEL_CONFIG is absent", () => {
  const harness = createHarness();

  harness.window.PixelScript.init({
    endpoint: "https://tracker.example/event",
    siteId: "manual-site",
  });
  harness.window.PixelScript.setConsent("granted");

  assert.equal(harness.sent.beacons.length, 1);
  assert.equal(harness.sent.beacons[0].payload.event_name, "page_view");
  assert.equal(harness.sent.beacons[0].payload.site_id, "manual-site");
});

test("cookie fallback preserves anon identity when storage is unavailable", () => {
  const harness = createHarness({
    failingStorage: true,
    config: { endpoint: "https://tracker.example/event", siteId: "shop" },
  });

  harness.window.PixelScript.setConsent("granted");
  harness.window.PixelScript.track("custom_one");
  harness.window.PixelScript.track("custom_two");

  const customEvents = harness.sent.beacons
    .map((entry) => entry.payload)
    .filter((payload) => payload.event_name.startsWith("custom_"));

  assert.equal(customEvents.length, 2);
  assert.equal(customEvents[0].anon_id, customEvents[1].anon_id);
  assert.match(customEvents[0].anon_id, UUID_RE);
  assert.ok(harness.cookies.has("ps_anon_id"));
});

test("SPA pushState preserves first touch and refreshes last touch", () => {
  const harness = createHarness({
    url: "https://shop.example/start?utm_source=first&utm_campaign=launch",
    config: { endpoint: "https://tracker.example/event", siteId: "shop" },
  });

  harness.window.PixelScript.setConsent("granted");
  harness.clearDeliveries();

  harness.history.pushState({}, "", "/next?utm_source=retarget&utm_campaign=second&gclid=G123");

  assert.equal(harness.sent.beacons.length, 1);
  const payload = harness.sent.beacons[0].payload;
  assert.equal(payload.event_name, "page_view");
  assert.equal(payload.page_path, "/next");
  assert.equal(payload.attribution.first_touch.utm_source, "first");
  assert.equal(payload.attribution.first_touch.utm_campaign, "launch");
  assert.equal(payload.attribution.last_touch.utm_source, "retarget");
  assert.equal(payload.attribution.last_touch.utm_campaign, "second");
  assert.equal(payload.attribution.last_touch.gclid, "G123");
});

test("data-track click sends endpoint event and standard Meta fbq event", () => {
  const harness = createHarness({
    config: { endpoint: "https://tracker.example/event", siteId: "shop" },
  });
  harness.window.PixelScript.setConsent("granted");
  harness.clearDeliveries();

  const button = makeElement("button", {
    id: "lead-button",
    className: "primary cta",
    innerText: "Talk to sales",
    dataset: { track: "Lead" },
    parentElement: harness.document.body,
  });

  harness.document.dispatchEvent({ type: "click", target: button });

  assert.equal(harness.sent.beacons.length, 1);
  assert.equal(harness.sent.beacons[0].payload.event_name, "Lead");
  assert.equal(harness.sent.beacons[0].payload.properties.tag, "button");
  assert.equal(harness.sent.beacons[0].payload.properties.text, "Talk to sales");
  assert.equal(harness.sent.beacons[0].payload.properties.class, "primary");
  assert.deepEqual(plain(harness.fbqCalls[0]), [
    "track",
    "Lead",
    harness.sent.beacons[0].payload.properties,
    { eventID: harness.sent.beacons[0].payload.event_id },
  ]);
});

test("custom data-track click uses fbq trackCustom", () => {
  const harness = createHarness({
    config: { endpoint: "https://tracker.example/event", siteId: "shop" },
  });
  harness.window.PixelScript.setConsent("granted");
  harness.clearDeliveries();

  const button = makeElement("button", {
    innerText: "Open calculator",
    dataset: { track: "CalculatorOpened" },
    parentElement: harness.document.body,
  });

  harness.document.dispatchEvent({ type: "click", target: button });

  assert.equal(harness.sent.beacons[0].payload.event_name, "CalculatorOpened");
  assert.equal(harness.fbqCalls[0][0], "trackCustom");
  assert.equal(harness.fbqCalls[0][1], "CalculatorOpened");
  assert.deepEqual(plain(harness.fbqCalls[0][3]), { eventID: harness.sent.beacons[0].payload.event_id });
});

test("provided event ID is shared by endpoint payload and Meta browser pixel", () => {
  const harness = createHarness({
    config: { endpoint: "https://tracker.example/event", siteId: "shop" },
  });
  harness.window.PixelScript.setConsent("granted");
  harness.clearDeliveries();

  const payload = harness.window.PixelScript.trackPurchase(
    { value: 25, currency: "USD", event_id: "purchase-123" }
  );

  assert.equal(payload.event_id, "purchase-123");
  assert.equal(payload.properties.event_id, undefined);
  assert.equal(harness.sent.beacons[0].payload.event_id, "purchase-123");
  assert.deepEqual(plain(harness.fbqCalls[0]), [
    "track",
    "Purchase",
    { value: 25, currency: "USD" },
    { eventID: "purchase-123" },
  ]);
});

test("outbound anchor click is tracked as outbound and does not call fbq", () => {
  const harness = createHarness({
    config: { endpoint: "https://tracker.example/event", siteId: "shop" },
  });
  harness.window.PixelScript.setConsent("granted");
  harness.clearDeliveries();

  const anchor = makeElement("a", {
    href: "https://external.example/pricing",
    innerText: "External pricing",
    dataset: { track: "Lead" },
    parentElement: harness.document.body,
  });

  harness.document.dispatchEvent({ type: "click", target: anchor });

  assert.equal(harness.sent.beacons.length, 1);
  assert.equal(harness.sent.beacons[0].payload.event_name, "outbound_click");
  assert.equal(harness.sent.beacons[0].payload.properties.outbound_url, "https://external.example/pricing");
  assert.equal(harness.fbqCalls.length, 0);
});

test("form submit excludes hidden and password fields and maps standard form event", () => {
  const harness = createHarness({
    config: { endpoint: "https://tracker.example/event", siteId: "shop" },
  });
  harness.window.PixelScript.setConsent("granted");
  harness.clearDeliveries();

  const form = makeElement("form", {
    id: "signup",
    name: "signup-form",
    action: "/signup",
    dataset: { trackForm: "Lead" },
  });
  form.elements = [
    makeElement("input", { name: "email", type: "email", form }),
    makeElement("input", { name: "csrf", type: "hidden", form }),
    makeElement("input", { name: "password", type: "password", form }),
    makeElement("textarea", { name: "message", form }),
  ];

  harness.document.dispatchEvent({ type: "submit", target: form });

  assert.equal(harness.sent.beacons[0].payload.event_name, "Lead");
  assert.deepEqual(harness.sent.beacons[0].payload.properties.fields, ["email", "message"]);
  assert.deepEqual(harness.fbqCalls[0][0], "track");
});

test("field focus ignores passwords but tracks text inputs", () => {
  const harness = createHarness({
    config: { endpoint: "https://tracker.example/event", siteId: "shop" },
  });
  harness.window.PixelScript.setConsent("granted");
  harness.clearDeliveries();

  const form = makeElement("form", { id: "account" });
  const password = makeElement("input", { name: "password", type: "password", form });
  const email = makeElement("input", { name: "email", type: "email", form });

  harness.document.dispatchEvent({ type: "focusin", target: password });
  harness.document.dispatchEvent({ type: "focusin", target: email });

  assert.equal(harness.sent.beacons.length, 1);
  assert.equal(harness.sent.beacons[0].payload.event_name, "form_field_focus");
  assert.equal(harness.sent.beacons[0].payload.properties.field_name, "email");
  assert.equal(harness.sent.beacons[0].payload.properties.form_id, "account");
});

test("scroll depth thresholds fire once per page", () => {
  const harness = createHarness({
    config: { endpoint: "https://tracker.example/event", siteId: "shop" },
    innerHeight: 1000,
    docHeight: 2000,
  });
  harness.document.body.scrollHeight = 2000;
  harness.document.body.offsetHeight = 2000;
  harness.window.PixelScript.setConsent("granted");
  harness.clearDeliveries();

  harness.window.scrollY = 760;
  harness.window.dispatchEvent({ type: "scroll" });
  harness.window.dispatchEvent({ type: "scroll" });
  harness.window.scrollY = 1000;
  harness.window.dispatchEvent({ type: "scroll" });

  const depths = harness.sent.beacons.map((entry) => entry.payload.properties.depth_percent);
  assert.deepEqual(depths, [25, 50, 75, 100]);
});

test("sendBeacon false falls back to fetch keepalive", () => {
  const harness = createHarness({
    config: { endpoint: "https://tracker.example/event", siteId: "shop" },
    beaconReturn: false,
  });

  harness.window.PixelScript.setConsent("granted");

  assert.equal(harness.sent.beacons.length, 1);
  assert.equal(harness.sent.fetches.length, 1);
  assert.equal(harness.sent.fetches[0].endpoint, "https://tracker.example/event");
  assert.equal(harness.sent.fetches[0].init.keepalive, true);
  assert.equal(harness.sent.fetches[0].init.headers["X-SDK-Version"], "1.2.0");
  assert.equal(harness.sent.fetches[0].payload.event_name, "page_view");
});

test("fetch failures persist offline buffer and online retry sends once", async () => {
  let shouldFail = true;
  const harness = createHarness({
    config: { endpoint: "https://tracker.example/event", siteId: "shop" },
    disableBeacon: true,
    fetchImpl: () => {
      if (shouldFail) return Promise.reject(new Error("network down"));
      return Promise.resolve({ ok: true, status: 202 });
    },
  });

  harness.window.PixelScript.setConsent("granted");
  await tick();

  const stored = storedJson(harness.localStorage, "ps_offline_buffer");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].event_name, "page_view");

  harness.sent.fetches.length = 0;
  shouldFail = false;
  harness.window.dispatchEvent({ type: "online" });
  await tick();

  assert.equal(harness.sent.fetches.length, 1);
  assert.equal(harness.sent.fetches[0].payload.event_name, "page_view");
  assert.deepEqual(storedJson(harness.localStorage, "ps_offline_buffer"), []);
});

test("auto-detected ViewContent sends endpoint event and Meta standard fbq", () => {
  const content = makeElement("div", {
    attrs: {
      "data-content-name": "Trail Shoe",
      "data-content-category": "Footwear",
      "data-content-ids": "sku-123",
      "data-content-type": "product",
      "data-value": "149.95",
      "data-currency": "USD",
    },
  });
  const harness = createHarness({
    config: { endpoint: "https://tracker.example/event", siteId: "shop" },
    trackContentElement: content,
  });

  harness.window.PixelScript.setConsent("granted");

  assert.equal(harness.sent.beacons.length, 2);
  const viewContent = harness.sent.beacons[1].payload;
  assert.equal(viewContent.event_name, "ViewContent");
  assert.deepEqual(viewContent.properties, {
    content_name: "Trail Shoe",
    content_category: "Footwear",
    content_ids: "sku-123",
    content_type: "product",
    value: 149.95,
    currency: "USD",
  });
  assert.deepEqual(plain(harness.fbqCalls[0]), [
    "track",
    "ViewContent",
    viewContent.properties,
    { eventID: viewContent.event_id },
  ]);
});

test("click on text input with a value does not capture the value as text", () => {
  const harness = createHarness({
    config: { endpoint: "https://tracker.example/event", siteId: "shop" },
  });
  harness.window.PixelScript.setConsent("granted");
  harness.clearDeliveries();

  // Input with a pre-filled phone number — simulates a user clicking a filled field
  const input = makeElement("input", {
    type: "tel",
    name: "mobile",
    value: "919548357723",
    parentElement: harness.document.body,
  });

  harness.document.dispatchEvent({ type: "click", target: input });

  assert.equal(harness.sent.beacons.length, 1);
  assert.equal(harness.sent.beacons[0].payload.event_name, "click");
  assert.equal(harness.sent.beacons[0].payload.properties.text, "");
});

test("submit input button captures its value label, not treated as PII", () => {
  const harness = createHarness({
    config: { endpoint: "https://tracker.example/event", siteId: "shop" },
  });
  harness.window.PixelScript.setConsent("granted");
  harness.clearDeliveries();

  const submitBtn = makeElement("input", {
    type: "submit",
    value: "Place Order",
    parentElement: harness.document.body,
  });

  harness.document.dispatchEvent({ type: "click", target: submitBtn });

  assert.equal(harness.sent.beacons.length, 1);
  assert.equal(harness.sent.beacons[0].payload.event_name, "Purchase");
  assert.equal(harness.sent.beacons[0].payload.properties.text, "Place Order");
});

test("Pay currency button is detected as Purchase", () => {
  const harness = createHarness({
    config: { endpoint: "https://tracker.example/event", siteId: "shop" },
  });
  harness.window.PixelScript.setConsent("granted");
  harness.clearDeliveries();

  const payBtn = makeElement("button", {
    innerText: "Pay ₹10,694",
    className: "pay-btn",
    parentElement: harness.document.body,
  });

  harness.document.dispatchEvent({ type: "click", target: payBtn });

  assert.equal(harness.sent.beacons.length, 1);
  assert.equal(harness.sent.beacons[0].payload.event_name, "Purchase");
  assert.equal(harness.sent.beacons[0].payload.properties.value, 10694);
  assert.equal(harness.sent.beacons[0].payload.properties.currency, "INR");
  assert.equal(harness.fbqCalls.length, 1);
  assert.equal(harness.fbqCalls[0][1], "Purchase");
});

test("rapid duplicate Meta events within 1500ms are deduped to one beacon", () => {
  const harness = createHarness({
    config: { endpoint: "https://tracker.example/event", siteId: "shop" },
  });
  harness.window.PixelScript.setConsent("granted");
  harness.clearDeliveries();

  const btn1 = makeElement("button", {
    innerText: "Add to cart",
    className: "main-btn",
    parentElement: harness.document.body,
  });
  const btn2 = makeElement("button", {
    innerText: "Add to cart",
    className: "fbt-btn",
    parentElement: harness.document.body,
  });

  // Two "Add to cart" buttons fire in rapid succession (same user click)
  harness.document.dispatchEvent({ type: "click", target: btn1 });
  harness.document.dispatchEvent({ type: "click", target: btn2 });

  assert.equal(harness.sent.beacons.length, 1);
  assert.equal(harness.sent.beacons[0].payload.event_name, "AddToCart");
  assert.equal(harness.fbqCalls.length, 1);
});

async function run() {
  let failures = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`not ok - ${name}`);
      console.error(error.stack || error.message);
    }
  }

  if (failures) {
    console.error(`${failures} test(s) failed`);
    process.exitCode = 1;
    return;
  }

  console.log(`${tests.length} test(s) passed`);
}

run();
