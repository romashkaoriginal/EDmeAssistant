const test = require("node:test");
const assert = require("node:assert/strict");
const { MoyKlassService, gradeFromName } = require("../src/moy-klass");

test("Moy Klass uses the company key only to obtain a temporary access token", async () => {
  const requests = [];
  const service = new MoyKlassService({
    apiKey: "company-key",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, text: async () => JSON.stringify({ accessToken: "temporary-token" }) };
    },
  });
  assert.equal(await service.getAccessToken(), "temporary-token");
  assert.equal(requests[0].url, "https://api.moyklass.com/v1/company/auth/getToken");
  assert.deepEqual(JSON.parse(requests[0].options.body), { apiKey: "company-key" });
});

test("Moy Klass extracts a grade only from an explicit class label", () => {
  assert.equal(gradeFromName("Математика, 8 класс"), 8);
  assert.equal(gradeFromName("Подготовка к ЦТ"), null);
});
