const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../src/app");

test("health endpoint reports AI configuration without a database query", async () => {
  const app = createApp({ database: {}, analyzer: { isConfigured: () => false } });
  const response = await request(app).get("/health").expect(200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.aiConfigured, false);
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
