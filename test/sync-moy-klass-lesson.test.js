const test = require("node:test");
const assert = require("node:assert/strict");
const { IntegrationRepository } = require("../src/database/repositories");

function createMockPool({ existing = null, claimSucceeds = true, mtsSession = null } = {}) {
  const queries = [];
  let transcriptCreates = 0;
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
      if (/SELECT .* FROM my_klass_lessons WHERE my_klass_lesson_id/.test(sql)) {
        return { rows: existing ? [existing] : [] };
      }
      if (/SELECT event_session_id FROM mts_link_sessions/.test(sql)) {
        return { rows: mtsSession ? [mtsSession] : [] };
      }
      if (/UPDATE my_klass_lessons SET transcript_created = TRUE/.test(sql)) {
        return { rows: claimSucceeds ? [{ myKlassLessonId: params[0] }] : [] };
      }
      if (/UPDATE my_klass_lessons SET transcript_created = FALSE/.test(sql)) {
        return { rows: [] };
      }
      if (/UPDATE my_klass_lessons SET lesson_date/.test(sql) || /INSERT INTO my_klass_lessons/.test(sql)) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const learning = {
    createTranscript: async () => {
      transcriptCreates += 1;
      return { id: 1 };
    },
  };
  return { pool, learning, queries, get transcriptCreates() { return transcriptCreates; } };
}

test("syncMoyKlassLesson creates a transcript only when the atomic claim succeeds", async () => {
  const mock = createMockPool({ existing: null, claimSucceeds: true });
  const repo = new IntegrationRepository(mock.pool, mock.learning);
  const result = await repo.syncMoyKlassLesson({
    myKlassLessonId: "77",
    tutorId: 9,
    studentId: 55,
    lessonDate: "2026-04-18",
    topic: "Дроби",
    description: "Разобрали обыкновенные дроби",
    payload: { id: 77 },
  });
  assert.deepEqual(result, { created: true, transcriptCreated: true });
  assert.equal(mock.transcriptCreates, 1);
  assert.ok(mock.queries.some((q) => q.sql.includes("transcript_created = TRUE") && q.sql.includes("transcript_created = FALSE")));
});

test("syncMoyKlassLesson skips transcript when another sync already claimed it", async () => {
  const mock = createMockPool({
    existing: { myKlassLessonId: "77", transcriptCreated: false },
    claimSucceeds: false,
  });
  const repo = new IntegrationRepository(mock.pool, mock.learning);
  const result = await repo.syncMoyKlassLesson({
    myKlassLessonId: "77",
    tutorId: 9,
    studentId: 55,
    lessonDate: "2026-04-18",
    topic: "Дроби",
    description: "Разобрали обыкновенные дроби",
    payload: { id: 77 },
  });
  assert.deepEqual(result, { created: false, transcriptCreated: false });
  assert.equal(mock.transcriptCreates, 0);
});

test("syncMoyKlassLesson does not create a transcript without a description", async () => {
  const mock = createMockPool({ existing: null });
  const repo = new IntegrationRepository(mock.pool, mock.learning);
  const result = await repo.syncMoyKlassLesson({
    myKlassLessonId: "77",
    tutorId: 9,
    studentId: 55,
    lessonDate: "2026-04-18",
    topic: null,
    description: "  ",
    payload: { id: 77 },
  });
  assert.deepEqual(result, { created: true, transcriptCreated: false });
  assert.equal(mock.transcriptCreates, 0);
});
