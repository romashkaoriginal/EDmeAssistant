const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

class PostgresDatabase {
  constructor(connectionString) {
    this.pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  }

  async initialize() {
    const migrationsDir = path.join(__dirname, "..", "db", "migrations");
    for (const filename of fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
      await this.pool.query(fs.readFileSync(path.join(migrationsDir, filename), "utf8"));
    }
    const { rows } = await this.pool.query("SELECT COUNT(*)::int AS count FROM tutors");
    if (rows[0].count === 0) await this.seedDemoData();
  }

  async seedDemoData() {
    const tutor = await this.pool.query("INSERT INTO tutors (full_name, email) VALUES ($1, $2) RETURNING id", ["Демо-репетитор", "demo@edme.local"]);
    const tutorId = tutor.rows[0].id;
    for (const student of [["Иван Петров", "Математика", 8, "demo-mk-001", "средний", "Уверенно освоить алгебру за 8 класс"], ["Анна Сидорова", "Физика", 9, "demo-mk-002", "средний", "Подготовиться к контрольной по механике"]]) {
      const result = await this.pool.query("INSERT INTO students (full_name, subject, grade, my_class_id, tutor_id) VALUES ($1, $2, $3, $4, $5) RETURNING id", [...student.slice(0, 4), tutorId]);
      await this.pool.query("INSERT INTO student_cards (student_id, current_level, learning_goal) VALUES ($1, $2, $3)", [result.rows[0].id, student[4], student[5]]);
    }
  }

  async getTutorByTelegramId(telegramId) { return this.one("SELECT * FROM tutors WHERE telegram_id = $1 AND is_active = TRUE", [String(telegramId)]); }
  async getTutorByIdentity(identity) {
    const normalized = String(identity).trim();
    if (normalized.includes("@")) return this.one("SELECT * FROM tutors WHERE LOWER(email) = LOWER($1) AND is_active = TRUE", [normalized]);
    const phone = normalized.replace(/\D/g, "");
    return phone ? this.one("SELECT * FROM tutors WHERE phone = $1 AND is_active = TRUE", [phone]) : null;
  }
  async listStudents(tutorId) { return this.rows("SELECT * FROM students WHERE tutor_id = $1 AND status = 'active' ORDER BY full_name", [tutorId]); }
  async getStudent(studentId, tutorId) { return this.one("SELECT * FROM students WHERE id = $1 AND tutor_id = $2", [studentId, tutorId]); }
  async getCard(studentId) { return this.one(`SELECT student_id AS "studentId", current_level AS "currentLevel", strengths, weaknesses, gaps, recommendations, learning_goal AS "learningGoal", learning_pace AS "learningPace", features, next_lesson_plan AS "nextLessonPlan", updated_at AS "updatedAt" FROM student_cards WHERE student_id = $1`, [studentId]); }
  async listHistory(studentId) { return this.rows(`SELECT id, source, changes, created_at AS "createdAt" FROM card_history WHERE student_id = $1 ORDER BY id DESC`, [studentId]); }
  async getTranscript(id, tutorId) { return this.one(`SELECT id, student_id AS "studentId", tutor_id AS "tutorId", lesson_date AS "lessonDate", text, status, analysis_result AS "analysisResult", created_at AS "createdAt" FROM transcripts WHERE id = $1 AND tutor_id = $2`, [id, tutorId]); }
  async listTranscripts(studentId, tutorId) { return this.rows(`SELECT id, student_id AS "studentId", tutor_id AS "tutorId", lesson_date AS "lessonDate", text, status, analysis_result AS "analysisResult", created_at AS "createdAt" FROM transcripts WHERE student_id = $1 AND tutor_id = $2 ORDER BY lesson_date DESC, id DESC`, [studentId, tutorId]); }
  async getDraft(id, tutorId) { return this.one(`SELECT id, transcript_id AS "transcriptId", student_id AS "studentId", tutor_id AS "tutorId", changes, status, created_at AS "createdAt", updated_at AS "updatedAt", approved_at AS "approvedAt" FROM analysis_drafts WHERE id = $1 AND tutor_id = $2`, [id, tutorId]); }
  async getDraftByTranscript(transcriptId, tutorId) { return this.one(`SELECT id, transcript_id AS "transcriptId", student_id AS "studentId", tutor_id AS "tutorId", changes, status, created_at AS "createdAt", updated_at AS "updatedAt", approved_at AS "approvedAt" FROM analysis_drafts WHERE transcript_id = $1 AND tutor_id = $2`, [transcriptId, tutorId]); }
  async getMtsSession(eventSessionId) { return this.one(`SELECT event_session_id AS "eventSessionId", my_klass_lesson_id AS "myKlassLessonId", student_id AS "studentId", tutor_id AS "tutorId", synced_at AS "syncedAt" FROM mts_link_sessions WHERE event_session_id = $1`, [String(eventSessionId)]); }
  async getMtsWebhook(transcriptId) { return this.one(`SELECT transcript_id AS "transcriptId", event_session_id AS "eventSessionId", local_transcript_id AS "localTranscriptId", status, raw_payload AS "rawPayload", error_message AS "errorMessage", received_at AS "receivedAt", updated_at AS "updatedAt" FROM mts_link_webhooks WHERE transcript_id = $1`, [String(transcriptId)]); }

  async bindTutorTelegramId(tutorId, telegramId) {
    const existing = await this.getTutorByTelegramId(telegramId);
    if (existing && Number(existing.id) !== Number(tutorId)) return null;
    const result = await this.pool.query(`UPDATE tutors SET telegram_id = $1 WHERE id = $2
      AND (telegram_id IS NULL OR telegram_id = $1) RETURNING *`, [String(telegramId), tutorId]);
    return result.rows[0] || null;
  }

  async updateCard(studentId, tutorId, patch, source = "manual", client = this.pool) {
    const current = await this.getCard(studentId);
    if (!current) throw new Error("Student card not found");
    const next = { ...current, ...patch };
    const result = await client.query(`UPDATE student_cards SET current_level = $1, strengths = $2, weaknesses = $3, gaps = $4, recommendations = $5, learning_goal = $6, learning_pace = $7, features = $8, next_lesson_plan = $9, updated_at = NOW() WHERE student_id = $10 RETURNING student_id AS "studentId", current_level AS "currentLevel", strengths, weaknesses, gaps, recommendations, learning_goal AS "learningGoal", learning_pace AS "learningPace", features, next_lesson_plan AS "nextLessonPlan", updated_at AS "updatedAt"`, [next.currentLevel || null, JSON.stringify(next.strengths || []), JSON.stringify(next.weaknesses || []), JSON.stringify(next.gaps || []), JSON.stringify(next.recommendations || []), next.learningGoal || null, next.learningPace || null, next.features || null, next.nextLessonPlan || null, studentId]);
    await client.query("INSERT INTO card_history (student_id, tutor_id, source, changes) VALUES ($1, $2, $3, $4)", [studentId, tutorId, source, JSON.stringify(patch)]);
    return result.rows[0];
  }

  async createTranscript({ studentId, tutorId, lessonDate, text }) {
    const result = await this.pool.query(`INSERT INTO transcripts (student_id, tutor_id, lesson_date, text) VALUES ($1, $2, $3, $4) RETURNING id`, [studentId, tutorId, lessonDate, text.trim()]);
    return this.getTranscript(result.rows[0].id, tutorId);
  }

  async saveAnalysis(transcriptId, tutorId, analysis) {
    const transcript = await this.getTranscript(transcriptId, tutorId);
    if (!transcript) return null;
    await this.pool.query("UPDATE transcripts SET status = 'analyzed', analysis_result = $1 WHERE id = $2", [JSON.stringify(analysis), transcriptId]);
    await this.pool.query(`INSERT INTO analysis_drafts (transcript_id, student_id, tutor_id, changes) VALUES ($1, $2, $3, $4) ON CONFLICT(transcript_id) DO UPDATE SET changes = EXCLUDED.changes, status = 'draft', updated_at = NOW(), approved_at = NULL`, [transcriptId, transcript.studentId, tutorId, JSON.stringify(analysis)]);
    return this.getDraftByTranscript(transcriptId, tutorId);
  }

  async createAiAnalysisLog({ transcriptId, studentId, tutorId, provider, model, status, inputTokens = null, outputTokens = null, totalTokens = null, estimatedCostUsd = null, durationMs = null, rawResponse = null, errorMessage = null }) {
    const result = await this.pool.query(`INSERT INTO ai_analysis_logs (
      transcript_id, student_id, tutor_id, provider, model, status, input_tokens, output_tokens,
      total_tokens, estimated_cost_usd, duration_ms, raw_response, error_message
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING id, status, provider, model, input_tokens AS "inputTokens", output_tokens AS "outputTokens",
      total_tokens AS "totalTokens", estimated_cost_usd AS "estimatedCostUsd", duration_ms AS "durationMs", created_at AS "createdAt"`, [
      transcriptId, studentId, tutorId, provider, model, status, inputTokens, outputTokens,
      totalTokens, estimatedCostUsd, durationMs, rawResponse, errorMessage,
    ]);
    return result.rows[0];
  }

  async updateDraft(id, tutorId, changes) {
    const draft = await this.getDraft(id, tutorId);
    if (!draft || draft.status !== "draft") return null;
    await this.pool.query("UPDATE analysis_drafts SET changes = $1, updated_at = NOW() WHERE id = $2", [JSON.stringify({ ...draft.changes, ...changes }), id]);
    return this.getDraft(id, tutorId);
  }

  async approveDraft(id, tutorId) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(`SELECT id, transcript_id AS "transcriptId", student_id AS "studentId", changes, status FROM analysis_drafts WHERE id = $1 AND tutor_id = $2 FOR UPDATE`, [id, tutorId]);
      const draft = result.rows[0];
      if (!draft || draft.status !== "draft") { await client.query("COMMIT"); return null; }
      await this.updateCard(draft.studentId, tutorId, { strengths: draft.changes.understood || [], weaknesses: draft.changes.difficulties || [], gaps: draft.changes.gaps || [], recommendations: draft.changes.recommendations || [], nextLessonPlan: draft.changes.nextLessonPlan || null }, "transcript", client);
      await client.query("UPDATE analysis_drafts SET status = 'approved', approved_at = NOW(), updated_at = NOW() WHERE id = $1", [id]);
      await client.query("UPDATE transcripts SET status = 'approved' WHERE id = $1", [draft.transcriptId]);
      await client.query("UPDATE students SET last_lesson_at = $1 WHERE id = $2", [draft.changes.lessonDate || new Date().toISOString().slice(0, 10), draft.studentId]);
      await client.query("COMMIT"); return this.getDraft(id, tutorId);
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async linkMtsSession({ eventSessionId, myKlassLessonId, studentId, tutorId }) {
    if (!await this.getStudent(studentId, tutorId)) return null;
    await this.pool.query(`INSERT INTO mts_link_sessions (event_session_id, my_klass_lesson_id, student_id, tutor_id) VALUES ($1, $2, $3, $4) ON CONFLICT(event_session_id) DO UPDATE SET my_klass_lesson_id = EXCLUDED.my_klass_lesson_id, student_id = EXCLUDED.student_id, tutor_id = EXCLUDED.tutor_id, synced_at = NOW()`, [String(eventSessionId), myKlassLessonId ? String(myKlassLessonId) : null, studentId, tutorId]);
    return this.getMtsSession(eventSessionId);
  }

  async registerMtsWebhook({ transcriptId, eventSessionId, payload }) {
    await this.pool.query(`INSERT INTO mts_link_webhooks (transcript_id, event_session_id, status, raw_payload) VALUES ($1, $2, 'received', $3) ON CONFLICT(transcript_id) DO NOTHING`, [String(transcriptId), String(eventSessionId), JSON.stringify(payload)]);
    return this.getMtsWebhook(transcriptId);
  }

  async updateMtsWebhook(transcriptId, { status, localTranscriptId = null, errorMessage = null }) {
    await this.pool.query("UPDATE mts_link_webhooks SET status = $1, local_transcript_id = COALESCE($2, local_transcript_id), error_message = $3, updated_at = NOW() WHERE transcript_id = $4", [status, localTranscriptId, errorMessage, String(transcriptId)]);
    return this.getMtsWebhook(transcriptId);
  }

  async one(sql, values) { const result = await this.pool.query(sql, values); return result.rows[0] || null; }
  async rows(sql, values) { return (await this.pool.query(sql, values)).rows; }
  async close() { await this.pool.end(); }
}

module.exports = { PostgresDatabase };
