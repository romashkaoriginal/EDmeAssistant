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
