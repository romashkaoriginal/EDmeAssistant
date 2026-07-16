const test = require("node:test");
const assert = require("node:assert/strict");
const { isLocalDatabase } = require("../src/postgres-database");

test("local PostgreSQL connections do not require TLS", () => {
  assert.equal(isLocalDatabase("postgresql://edme:edme@localhost:5432/edme_test"), true);
  assert.equal(isLocalDatabase("postgresql://edme:edme@127.0.0.1:5432/edme_test"), true);
  assert.equal(isLocalDatabase("postgresql://edme:edme@db.example.com:5432/edme"), false);
});
