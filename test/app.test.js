const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../src/app");

test("health endpoint does not expose internal configuration", async () => {
  const app = createApp({ database: {}, analyzer: { isConfigured: () => false } });
  const response = await request(app).get("/health").expect(200);
  assert.equal(response.body.ok, true);
  assert.equal("aiConfigured" in response.body, false);
});

test("MTS Link webhook receives the original body for signature validation", async () => {
  let rawBody;
  const app = createApp({
    database: {},
    analyzer: { isConfigured: () => false },
    mtsLink: { verifyWebhook: (request) => { rawBody = request.rawBody; return false; } },
  });
  await request(app).post("/webhooks/mts-link").send({ event: "transcript.ready" }).expect(401);
  assert.equal(Buffer.isBuffer(rawBody), true);
});

test("all internal API routes require the shared API secret", async () => {
  const metrics = { activeTutorsLast30Days: 2, generationsByType: [] };
  const app = createApp({
    database: { getMetrics: async () => metrics },
    analyzer: { isConfigured: () => false },
    apiSecret: "api-secret",
  });
  await request(app).get("/api/metrics").expect(401);
  await request(app).get("/api/materials").set("x-api-secret", "wrong").expect(401);
  const response = await request(app).get("/api/metrics").set("x-api-secret", "api-secret").expect(200);
  assert.deepEqual(response.body.metrics, metrics);
});

test("internal API is disabled when no secret is configured", async () => {
  const app = createApp({
    database: { getMetrics: async () => ({}) },
    analyzer: { isConfigured: () => false },
  });
  await request(app).get("/api/metrics").expect(503);
});

test("Telegram webhook refuses updates when its secret is absent or invalid", async () => {
  let processed = 0;
  const telegramBot = { processUpdate: async () => { processed += 1; } };
  const app = createApp({ database: {}, analyzer: { isConfigured: () => false }, telegramBot });
  await request(app).post("/webhooks/telegram").send({ update_id: 1 }).expect(503);

  const protectedApp = createApp({
    database: {}, analyzer: { isConfigured: () => false }, telegramBot, telegramWebhookSecret: "telegram-secret",
  });
  await request(protectedApp).post("/webhooks/telegram").send({ update_id: 1 }).expect(401);
  await request(protectedApp).post("/webhooks/telegram")
    .set("x-telegram-bot-api-secret-token", "telegram-secret").send({ update_id: 1 }).expect(200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(processed, 1);
});
