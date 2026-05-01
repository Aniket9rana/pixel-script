"use strict";

const assert = require("assert/strict");
const {
  configure,
  track,
  trackBoth,
  buildClientPixelEvent,
  buildClientPixelSnippet,
  sha256,
} = require("./server-events");
const { buildMetaEvent, sendToMeta } = require("./tracker/meta");
const { toRow } = require("./tracker/clickhouse");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function withFetch(mock, fn) {
  const originalFetch = global.fetch;
  global.fetch = mock;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = originalFetch;
    });
}

test("server-events hashes PII and builds tracker envelope from request context", async () => {
  let captured;
  configure({
    endpoint: "https://tracker.example/event",
    siteId: "server-site",
    timeout: 1000,
    debug: false,
  });

  const req = {
    headers: {
      "x-forwarded-for": "203.0.113.9, 10.0.0.5",
      "user-agent": "UnitTest/1.0",
      cookie: "_fbp=fbp-cookie",
    },
    socket: { remoteAddress: "127.0.0.1" },
    query: {
      fbclid: "FBCLICK",
      gclid: "GCLICK",
      utm_source: "newsletter",
      utm_medium: "email",
      utm_campaign: "spring",
      UTM_Custom: "creative",
      gbraid: "GBRAID",
      partner_click_id: "PCLICK",
      random: "drop",
    },
  };

  await withFetch(async (url, init) => {
    captured = { url, init, payload: JSON.parse(init.body) };
    return { status: 202 };
  }, async () => {
    const result = await track(
      "Purchase",
      { value: 19.99, currency: "USD", order_id: "order-1", event_id: "server-event-1" },
      req,
      {
        email: " Buyer@Example.COM ",
        phone: " +15551234567 ",
        first_name: " Ada ",
        external_id: "user-123",
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.status, 202);
    assert.equal(result.event_id, "server-event-1");
    assert.equal(result.payload.event_id, "server-event-1");
  });

  assert.equal(captured.url, "https://tracker.example/event");
  assert.equal(captured.init.headers["Content-Type"], "application/json");
  assert.equal(captured.payload.event_id, "server-event-1");
  assert.equal(captured.payload.event_name, "Purchase");
  assert.equal(captured.payload.site_id, "server-site");
  assert.equal(captured.payload.source, "server");
  assert.equal(captured.payload.ip, "203.0.113.9");
  assert.equal(captured.payload.user_agent, "UnitTest/1.0");
  assert.equal(captured.payload.fbp, "fbp-cookie");
  assert.match(captured.payload.fbc, /^fb\.1\.\d+\.FBCLICK$/);
  assert.deepEqual(captured.payload.attribution, {
    first_touch: {
      utm_source: "newsletter",
      utm_medium: "email",
      utm_campaign: "spring",
      utm_custom: "creative",
      fbclid: "FBCLICK",
      gclid: "GCLICK",
      gbraid: "GBRAID",
      partner_click_id: "PCLICK",
    },
    last_touch: {
      utm_source: "newsletter",
      utm_medium: "email",
      utm_campaign: "spring",
      utm_custom: "creative",
      fbclid: "FBCLICK",
      gclid: "GCLICK",
      gbraid: "GBRAID",
      partner_click_id: "PCLICK",
    },
  });
  assert.equal(captured.payload.user_data.email, sha256("buyer@example.com"));
  assert.equal(captured.payload.user_data.phone, sha256("+15551234567"));
  assert.equal(captured.payload.user_data.first_name, sha256("ada"));
  assert.equal(captured.payload.user_data.external_id, "user-123");
  assert.equal(captured.payload.properties.order_id, "order-1");
  assert.equal(captured.payload.properties.event_id, undefined);
});

test("server-events returns a non-throwing result when delivery fails", async () => {
  configure({
    endpoint: "https://tracker.example/event",
    siteId: "server-site",
    timeout: 1000,
    debug: false,
  });

  const originalError = console.error;
  console.error = () => {};
  try {
    await withFetch(async () => {
      throw new Error("network down");
    }, async () => {
      const result = await track("Lead", { form_id: "lead" });
      assert.equal(result.ok, false);
      assert.equal(result.error, "network down");
    });
  } finally {
    console.error = originalError;
  }
});

test("server-events can build matching browser Pixel and server events", async () => {
  let captured;
  configure({
    endpoint: "https://tracker.example/event",
    siteId: "server-site",
    timeout: 1000,
    debug: false,
  });

  const browserEvent = buildClientPixelEvent("Lead", {
    form_id: "lead-form",
    eventId: "lead-123",
  });
  assert.deepEqual(browserEvent, {
    event_name: "Lead",
    event_id: "lead-123",
    properties: { form_id: "lead-form" },
  });
  assert.equal(
    buildClientPixelSnippet("Lead", { form_id: "lead-form" }, { eventId: "lead-123" }),
    '<script>(function(){if(window.PixelScript&&typeof window.PixelScript.trackMetaEvent===\'function\'){window.PixelScript.trackMetaEvent("Lead",{"form_id":"lead-form"},{eventId:"lead-123"});}})();</script>'
  );

  await withFetch(async (url, init) => {
    captured = { url, init, payload: JSON.parse(init.body) };
    return { status: 202 };
  }, async () => {
    const result = await trackBoth(
      "Lead",
      { form_id: "lead-form" },
      null,
      {},
      { eventId: "lead-123" }
    );

    assert.equal(result.event_id, "lead-123");
    assert.equal(result.server.event_id, "lead-123");
    assert.equal(result.client_pixel.event_id, "lead-123");
    assert.equal(result.client_pixel.properties.form_id, "lead-form");
  });

  assert.equal(captured.payload.event_id, "lead-123");
  assert.equal(captured.payload.properties.form_id, "lead-form");
});

test("buildMetaEvent maps user_data, passthrough fields, and conversion custom_data", () => {
  const metaEvent = buildMetaEvent({
    event_id: "11111111-1111-4111-8111-111111111111",
    event_name: "Purchase",
    timestamp: "2026-05-01T08:00:00.000Z",
    page_url: "https://shop.example/checkout",
    source: "server",
    ip: "203.0.113.9",
    user_agent: "UnitTest/1.0",
    fbp: "fbp",
    fbc: "fbc",
    user_data: {
      email: "email-hash",
      phone: "phone-hash",
      external_id: "external-hash",
      client_ip_address: "198.51.100.10",
    },
    properties: {
      value: 42,
      currency: "USD",
      order_id: "order-2",
      ignored_field: "drop-me",
    },
  });

  assert.equal(metaEvent.event_name, "Purchase");
  assert.equal(metaEvent.event_time, 1777622400);
  assert.equal(metaEvent.event_source_url, "https://shop.example/checkout");
  assert.deepEqual(metaEvent.user_data.em, ["email-hash"]);
  assert.deepEqual(metaEvent.user_data.ph, ["phone-hash"]);
  assert.deepEqual(metaEvent.user_data.external_id, ["external-hash"]);
  assert.equal(metaEvent.user_data.client_ip_address, "203.0.113.9");
  assert.equal(metaEvent.user_data.client_user_agent, "UnitTest/1.0");
  assert.equal(metaEvent.user_data.fbp, "fbp");
  assert.equal(metaEvent.user_data.fbc, "fbc");
  assert.deepEqual(metaEvent.custom_data, {
    value: 42,
    currency: "USD",
    order_id: "order-2",
  });
});

test("buildMetaEvent omits custom_data when properties have no recognized conversion fields", () => {
  const metaEvent = buildMetaEvent({
    event_name: "CustomSignal",
    properties: { internal_only: true },
  });

  assert.equal(Object.prototype.hasOwnProperty.call(metaEvent, "custom_data"), false);
});

test("sendToMeta posts the expected CAPI body and test event code", async () => {
  let captured;
  await withFetch(async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ events_received: 1 }),
    };
  }, async () => {
    const result = await sendToMeta(
      {
        event_id: "11111111-1111-4111-8111-111111111111",
        event_name: "Lead",
        timestamp: "2026-05-01T08:00:00.000Z",
        user_data: { email: "email-hash" },
      },
      {
        pixelId: "123456789",
        accessToken: "token",
        testEventCode: "TEST123",
      }
    );

    assert.deepEqual(result, {
      success: true,
      status: 200,
      trace_id: 1,
      meta_raw: { events_received: 1 },
    });
  });

  assert.equal(captured.url, "https://graph.facebook.com/v25.0/123456789/events?access_token=token");
  assert.equal(captured.init.headers["Content-Type"], "application/json");
  assert.equal(captured.body.test_event_code, "TEST123");
  assert.equal(captured.body.data.length, 1);
  assert.equal(captured.body.data[0].event_name, "Lead");
  assert.deepEqual(captured.body.data[0].user_data.em, ["email-hash"]);
});

test("sendToMeta skips cleanly when credentials are missing", async () => {
  const result = await sendToMeta({ event_name: "Lead" }, {});

  assert.deepEqual(result, {
    success: false,
    error: "META_PIXEL_ID or META_ACCESS_TOKEN not configured",
  });
});

test("ClickHouse toRow flattens nested attribution and preserves JSON properties", () => {
  const row = toRow({
    event_id: "11111111-1111-4111-8111-111111111111",
    event_name: "Purchase",
    site_id: "shop",
    source: "client",
    anon_id: "22222222-2222-4222-8222-222222222222",
    session_id: "33333333-3333-4333-8333-333333333333",
    page_url: "https://shop.example/checkout",
    page_path: "/checkout",
    referrer: "https://shop.example/cart",
    attribution: {
      first_touch: {
        utm_source: "meta",
        utm_medium: "cpc",
        utm_campaign: "launch",
        utm_term: "shoes",
        utm_content: "blue",
        fbclid: "FB1",
        gbraid: "GB1",
      },
      last_touch: {
        utm_source: "google",
        utm_medium: "search",
        utm_campaign: "brand",
        gclid: "G1",
        wbraid: "WB1",
        partner_click_id: "PCLICK",
      },
    },
    fbp: "fbp",
    fbc: "fbc",
    ip: "203.0.113.9",
    user_agent: "UnitTest/1.0",
    properties: { value: 19.99, currency: "USD" },
    sdk_version: "1.0.0",
    timestamp: "2026-05-01T08:00:00.000Z",
  });

  assert.equal(row.event_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(row.anon_id, "22222222-2222-4222-8222-222222222222");
  assert.equal(row.session_id, "33333333-3333-4333-8333-333333333333");
  assert.equal(row.ft_utm_source, "meta");
  assert.equal(row.ft_utm_term, "shoes");
  assert.equal(row.ft_utm_content, "blue");
  assert.equal(row.ft_fbclid, "FB1");
  assert.equal(row.ft_gbraid, "GB1");
  assert.equal(row.lt_utm_source, "google");
  assert.equal(row.lt_gclid, "G1");
  assert.equal(row.lt_wbraid, "WB1");
  assert.equal(JSON.parse(row.attribution).last_touch.partner_click_id, "PCLICK");
  assert.deepEqual(JSON.parse(row.properties), { value: 19.99, currency: "USD" });
  assert.equal(row.received_at, "2026-05-01T08:00:00.000Z");
});

test("ClickHouse toRow replaces invalid UUIDs with zero UUIDs", () => {
  const row = toRow({
    event_id: "not-a-uuid",
    anon_id: "also-bad",
    event_name: "Lead",
  });

  assert.equal(row.event_id, ZERO_UUID);
  assert.equal(row.anon_id, ZERO_UUID);
  assert.equal(row.session_id, null);
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
