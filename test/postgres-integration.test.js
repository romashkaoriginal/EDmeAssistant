const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PostgresDatabase } = require("../src/postgres-database");

const connectionString = process.env.INTEGRATION_DATABASE_URL;

test("PostgreSQL applies migrations once and restores Telegram sessions after a restart", {
  skip: !connectionString && "INTEGRATION_DATABASE_URL is not configured",
}, async () => {
  const expectedMigrations = fs.readdirSync(path.join(__dirname, "..", "db", "migrations"))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  let firstDatabase;
  let restartedDatabase;

  try {
    firstDatabase = new PostgresDatabase(connectionString);
    await firstDatabase.initialize();
    const firstRun = await firstDatabase.pool.query("SELECT filename FROM schema_migrations ORDER BY filename");
    assert.deepEqual(firstRun.rows.map((row) => row.filename), expectedMigrations);

    await firstDatabase.initialize();
    const secondRun = await firstDatabase.pool.query("SELECT filename FROM schema_migrations ORDER BY filename");
    assert.deepEqual(secondRun.rows.map((row) => row.filename), expectedMigrations);

    await firstDatabase.setTelegramSession("integration-user", { action: "generationTopic", studentId: 42, type: "tasks" }, 300);
    await firstDatabase.close();
    firstDatabase = null;

    restartedDatabase = new PostgresDatabase(connectionString);
    await restartedDatabase.initialize();
    assert.deepEqual(await restartedDatabase.getTelegramSession("integration-user"), {
      action: "generationTopic",
      studentId: 42,
      type: "tasks",
    });
  } finally {
    await firstDatabase?.close();
    await restartedDatabase?.close();
  }
});

test("admin panel repository methods list, grant and edit", {
  skip: !connectionString && "INTEGRATION_DATABASE_URL is not configured",
}, async () => {
  const database = new PostgresDatabase(connectionString);
  try {
    await database.initialize();

    // Grant/revoke admin by phone: a tutor with a matching phone flips is_admin.
    const tutor = await database.upsertMoyKlassTutor({ id: `admtest-${Date.now()}`, name: "Админ Тест", phone: "375449998877" });
    assert.equal(tutor.is_admin, false);
    const granted = await database.setTutorAdminByPhone("+375 44 999-88-77", true);
    assert.equal(granted.isAdmin, true);
    assert.equal((await database.getTutorForAdmin(tutor.id)).isAdmin, true);
    const revoked = await database.setTutorAdminByPhone("375449998877", false);
    assert.equal(revoked.isAdmin, false);

    // Unknown phone returns null rather than throwing.
    assert.equal(await database.setTutorAdminByPhone("000000000000", true), null);

    // listTutors surfaces the new row with a student count.
    const tutors = await database.listTutors({ limit: 1000, offset: 0 });
    assert.ok(tutors.some((row) => Number(row.id) === Number(tutor.id)));

    // Bootstrap admin flag is applied on sync for the seeded phone.
    const bootstrap = await database.upsertMoyKlassTutor({ id: `admboot-${Date.now()}`, name: "Босс", phone: "375445839141" });
    assert.equal((await database.getTutorForAdmin(bootstrap.id)).isAdmin, true);

    // Material metadata edit via the admin path.
    await database.upsertMaterial({ mtsFileId: `mat-${Date.now()}`, name: "Старое", category: "grade", grade: 7, subject: "Физика", topic: "Сила", materialType: "тест", url: "https://example.com/a" });
    const [material] = await database.listMaterialsForAdmin({ limit: 1, offset: 0 });
    const updated = await database.updateMaterialMetadata(material.id, { name: "Новое", grade: 8 });
    assert.equal(updated.name, "Новое");
    assert.equal(updated.grade, 8);
  } finally {
    await database.close();
  }
});
