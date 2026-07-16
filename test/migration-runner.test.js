const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runMigrations } = require("../src/database/migration-runner");

function createPool(applied = new Map()) {
  const calls = [];
  const query = async (sql, values = []) => {
    calls.push([sql, values]);
    if (sql.startsWith("SELECT checksum")) return { rows: applied.has(values[0]) ? [{ checksum: applied.get(values[0]) }] : [] };
    if (sql.startsWith("INSERT INTO schema_migrations")) applied.set(values[0], values[1]);
    return { rows: [] };
  };
  return { calls, pool: { query, connect: async () => ({ query, release: () => {} }) } };
}

test("migration runner applies each new migration once and records its checksum", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edme-migrations-"));
  try {
    fs.writeFileSync(path.join(dir, "001_test.sql"), "CREATE TABLE test_one (id INT);");
    const { pool, calls } = createPool();
    await runMigrations(pool, dir);
    await runMigrations(pool, dir);

    assert.equal(calls.filter(([sql]) => sql === "CREATE TABLE test_one (id INT);").length, 1);
    assert.equal(calls.filter(([sql]) => sql.startsWith("INSERT INTO schema_migrations")).length, 1);
    assert.equal(calls.filter(([sql]) => sql.startsWith("SELECT pg_advisory_lock")).length, 2);
    assert.equal(calls.filter(([sql]) => sql.startsWith("SELECT pg_advisory_unlock")).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("migration runner rejects a changed applied migration", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edme-migrations-"));
  try {
    const filename = "001_test.sql";
    fs.writeFileSync(path.join(dir, filename), "CREATE TABLE changed (id INT);");
    const { pool } = createPool(new Map([[filename, "different-checksum"]]));
    await assert.rejects(() => runMigrations(pool, dir), /Applied migration was changed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
