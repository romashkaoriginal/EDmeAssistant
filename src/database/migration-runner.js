const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;
const LOCK_SQL = "SELECT pg_advisory_lock(hashtext('edmeassistant:migrations'))";
const UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext('edmeassistant:migrations'))";

function getMigrationFiles(migrationsDir) {
  return fs.readdirSync(migrationsDir)
    .filter((filename) => filename.endsWith(".sql"))
    .sort()
    .map((filename) => ({
      filename,
      sql: fs.readFileSync(path.join(migrationsDir, filename), "utf8"),
    }));
}

function checksum(sql) {
  return crypto.createHash("sha256").update(sql).digest("hex");
}

async function runMigrations(pool, migrationsDir) {
  const client = await pool.connect();
  try {
    await client.query(LOCK_SQL);
    await client.query(MIGRATIONS_TABLE_SQL);

    for (const migration of getMigrationFiles(migrationsDir)) {
      const migrationChecksum = checksum(migration.sql);
      const applied = await client.query(
        "SELECT checksum FROM schema_migrations WHERE filename = $1",
        [migration.filename],
      );

      if (applied.rows[0]) {
        if (applied.rows[0].checksum !== migrationChecksum) {
          throw new Error(`Applied migration was changed: ${migration.filename}`);
        }
        continue;
      }

      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
          [migration.filename, migrationChecksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query(UNLOCK_SQL).catch(() => {});
    client.release();
  }
}

module.exports = { checksum, getMigrationFiles, runMigrations };
