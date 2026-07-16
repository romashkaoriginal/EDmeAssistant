class Repository {
  constructor(pool) {
    this.pool = pool;
  }

  async one(sql, values) {
    const result = await this.pool.query(sql, values);
    return result.rows[0] || null;
  }

  async rows(sql, values) {
    return (await this.pool.query(sql, values)).rows;
  }
}

class TutorRepository extends Repository {
  async getByTelegramId(telegramId) { return this.one("SELECT * FROM tutors WHERE telegram_id = $1 AND is_active = TRUE", [String(telegramId)]); }
  // Phone-only lookup: the phone must come from Telegram's own "share
  // contact" button (message.contact), never typed in as free text, so a
  // stranger cannot claim a tutor's profile just by knowing their number.
  async getByPhone(phoneNumber) {
    const phone = String(phoneNumber).replace(/\D/g, "");
    return phone ? this.one("SELECT * FROM tutors WHERE phone = $1 AND is_active = TRUE ORDER BY id LIMIT 1", [phone]) : null;
  }

  async bindTelegramId(tutorId, telegramId) {
    const existing = await this.getByTelegramId(telegramId);
    if (existing && Number(existing.id) !== Number(tutorId)) return null;
    const result = await this.pool.query(`UPDATE tutors SET telegram_id = $1 WHERE id = $2
      AND (telegram_id IS NULL OR telegram_id = $1) RETURNING *`, [String(telegramId), tutorId]);
    return result.rows[0] || null;
  }

  async unbindTelegramId(telegramId) {
    const result = await this.pool.query(
      "UPDATE tutors SET telegram_id = NULL WHERE telegram_id = $1 RETURNING id, full_name, email",
      [String(telegramId)],
    );
    return result.rows[0] || null;
  }

  async upsertMoyKlassTutor(manager) {
    const tutor = await this.upsertMoyKlassTutorRow(manager);
    // Grant the bootstrap admin the moment their profile first syncs from Moy
    // Klass, even though the 012 migration ran before the row existed.
    if (tutor?.phone) await this.ensureBootstrapAdmin(tutor.phone);
    return tutor;
  }

  async upsertMoyKlassTutorRow(manager) {
    const myKlassId = String(manager.id);
    const email = manager.email || null;
    let phone = manager.phone ? String(manager.phone).replace(/\D/g, "") : null;
    if (phone === "") phone = null;
    const isActive = manager.isWork !== false && manager.blocked !== true;
    const byKlass = await this.one("SELECT * FROM tutors WHERE my_klass_id = $1", [myKlassId]);
    if (byKlass) {
      if (phone && await this.one("SELECT id FROM tutors WHERE phone = $1 AND id <> $2", [phone, byKlass.id])) phone = null;
      return this.one(`UPDATE tutors SET full_name = $1, email = $2, phone = $3, is_active = $4
        WHERE my_klass_id = $5 RETURNING *`, [manager.name, email, phone, isActive, myKlassId]);
    }
    if (phone) {
      const byPhone = await this.one("SELECT * FROM tutors WHERE phone = $1", [phone]);
      if (byPhone) {
        if (!byPhone.my_klass_id) return this.one(`UPDATE tutors SET full_name = $1, email = $2, my_klass_id = $3, is_active = $4
          WHERE id = $5 RETURNING *`, [manager.name, email, myKlassId, isActive, byPhone.id]);
        phone = null;
      }
    }
    if (email) {
      const byEmail = await this.one("SELECT * FROM tutors WHERE email = $1", [email]);
      if (byEmail && !byEmail.my_klass_id) return this.one(`UPDATE tutors SET full_name = $1, phone = COALESCE($2, phone), my_klass_id = $3, is_active = $4
        WHERE id = $5 RETURNING *`, [manager.name, phone, myKlassId, isActive, byEmail.id]);
    }
    return this.one(`INSERT INTO tutors (full_name, email, phone, my_klass_id, is_active)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (my_klass_id) WHERE my_klass_id IS NOT NULL DO UPDATE SET
        full_name = EXCLUDED.full_name, email = EXCLUDED.email, phone = EXCLUDED.phone, is_active = EXCLUDED.is_active
      RETURNING *`, [manager.name, email, phone, myKlassId, isActive]);
  }

  async upsertMoyKlassStudent(user, { subject, grade, tutorId }) {
    // Subject and grade are pair-level data (see linkStudent): another tutor may
    // teach the same student a different subject, so the conflict branch must
    // not overwrite them globally.
    // This `students` table is shared with another legacy app that added a
    // NOT NULL `name` column mirroring `full_name`; keep it in sync so inserts
    // from this app don't violate that constraint.
    const student = await this.one(`INSERT INTO students (full_name, name, subject, grade, my_class_id, my_klass_id, tutor_id, status)
      VALUES ($1, $1, $2, $3, $4, $5, $6, 'active')
      ON CONFLICT (my_klass_id) WHERE my_klass_id IS NOT NULL DO UPDATE SET
        full_name = EXCLUDED.full_name, name = EXCLUDED.name, my_class_id = EXCLUDED.my_class_id, status = 'active'
      RETURNING *`, [user.name, subject, grade, String(user.id), String(user.id), tutorId]);
    await this.pool.query("INSERT INTO student_cards (student_id) VALUES ($1) ON CONFLICT (student_id) DO NOTHING", [student.id]);
    return student;
  }

  async linkStudent(tutorId, studentId, { subject = null, grade = null } = {}) {
    await this.pool.query(`INSERT INTO tutor_students (tutor_id, student_id, subject, grade) VALUES ($1, $2, $3, $4)
      ON CONFLICT (tutor_id, student_id) DO UPDATE SET
        subject = COALESCE(EXCLUDED.subject, tutor_students.subject),
        grade = COALESCE(EXCLUDED.grade, tutor_students.grade),
        synced_at = NOW()`, [tutorId, studentId, subject, grade]);
  }

  // Drops a tutor-student link by the Moy Klass user id. Used when a student
  // attended a lesson but their current clientStatus no longer qualifies them
  // for the tutor's active list (e.g. they stopped studying) — otherwise a
  // link created before the status filter existed would linger forever.
  async unlinkStudentByMyKlassId(tutorId, myKlassId) {
    await this.pool.query(
      `DELETE FROM tutor_students WHERE tutor_id = $1 AND student_id = (SELECT id FROM students WHERE my_klass_id = $2)`,
      [tutorId, String(myKlassId)],
    );
  }

  // After a teacher sync, drop links that are no longer in the kept set
  // (no attended lessons in the window, or status no longer allowed). Without
  // this, a student linked once stays in the bot list forever.
  async pruneStudents(tutorId, keepStudentIds) {
    const ids = [...new Set((keepStudentIds || []).map(Number).filter(Number.isFinite))];
    if (!ids.length) {
      await this.pool.query("DELETE FROM tutor_students WHERE tutor_id = $1", [tutorId]);
      return;
    }
    await this.pool.query(
      "DELETE FROM tutor_students WHERE tutor_id = $1 AND NOT (student_id = ANY($2::bigint[]))",
      [tutorId, ids],
    );
  }

  // --- Admin panel (spec section 20) ---

  // Re-applies the bootstrap admin flag whenever the seeded phone number logs in
  // or is synced: the tutor row may not have existed when the migration ran.
  async ensureBootstrapAdmin(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (!digits || digits !== BOOTSTRAP_ADMIN_PHONE) return;
    await this.pool.query("UPDATE tutors SET is_admin = TRUE WHERE phone = $1", [digits]);
  }

  // Grant/revoke admin by phone. Matches any status so an admin can promote a
  // colleague before they have logged in. Returns the affected tutor or null.
  async setAdminByPhone(phone, value) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (!digits) return null;
    return this.one("UPDATE tutors SET is_admin = $1 WHERE phone = $2 RETURNING id, full_name AS \"fullName\", phone, email, is_admin AS \"isAdmin\", is_active AS \"isActive\", telegram_id AS \"telegramId\"", [Boolean(value), digits]);
  }

  async setActive(tutorId, value) {
    return this.one("UPDATE tutors SET is_active = $1 WHERE id = $2 RETURNING id, full_name AS \"fullName\", phone, email, is_admin AS \"isAdmin\", is_active AS \"isActive\", telegram_id AS \"telegramId\"", [Boolean(value), tutorId]);
  }

  async list({ limit = 50, offset = 0 } = {}) {
    return this.rows(`SELECT t.id, t.full_name AS "fullName", t.phone, t.email, t.my_klass_id AS "myKlassId", t.is_admin AS "isAdmin", t.is_active AS "isActive", t.telegram_id AS "telegramId",
      (SELECT COUNT(*)::int FROM tutor_students ts WHERE ts.tutor_id = t.id) AS "studentCount"
      FROM tutors t ORDER BY t.is_admin DESC, t.full_name LIMIT $1 OFFSET $2`, [limit, offset]);
  }

  async getForAdmin(tutorId) {
    return this.one(`SELECT t.id, t.full_name AS "fullName", t.phone, t.email, t.my_klass_id AS "myKlassId", t.is_admin AS "isAdmin", t.is_active AS "isActive", t.telegram_id AS "telegramId",
      (SELECT COUNT(*)::int FROM tutor_students ts WHERE ts.tutor_id = t.id) AS "studentCount"
      FROM tutors t WHERE t.id = $1`, [tutorId]);
  }

  // Same shape as getForAdmin but looked up by phone, ignoring is_active — an
  // admin must be able to find and inspect a disabled tutor's profile too.
  async getForAdminByPhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (!digits) return null;
    return this.one(`SELECT t.id, t.full_name AS "fullName", t.phone, t.email, t.my_klass_id AS "myKlassId", t.is_admin AS "isAdmin", t.is_active AS "isActive", t.telegram_id AS "telegramId",
      (SELECT COUNT(*)::int FROM tutor_students ts WHERE ts.tutor_id = t.id) AS "studentCount"
      FROM tutors t WHERE t.phone = $1`, [digits]);
  }
}

// Digits-only bootstrap admin phone (see migration 012_admin_role.sql).
const BOOTSTRAP_ADMIN_PHONE = "375445839141";

class LearningRepository extends Repository {
  async listStudents(tutorId) { return this.rows(`SELECT s.*, COALESCE(ts.subject, s.subject) AS subject, COALESCE(ts.grade, s.grade) AS grade FROM students s JOIN tutor_students ts ON ts.student_id = s.id WHERE ts.tutor_id = $1 AND s.status = 'active' ORDER BY s.full_name`, [tutorId]); }
  async getStudent(studentId, tutorId) { return this.one(`SELECT s.*, COALESCE(ts.subject, s.subject) AS subject, COALESCE(ts.grade, s.grade) AS grade FROM students s JOIN tutor_students ts ON ts.student_id = s.id WHERE s.id = $1 AND ts.tutor_id = $2`, [studentId, tutorId]); }
  // Admin views cross tutor boundaries: no tutorId scope (spec 5.2 "просматривать
  // карточки учеников"). Reads only — admins never edit tutors' student data here.
  async listAllStudents({ limit = 50, offset = 0 } = {}) {
    return this.rows(`SELECT s.id, s.full_name AS "fullName", s.subject, s.grade, s.status, s.my_klass_id AS "myKlassId", s.last_lesson_at AS "lastLessonAt", sc.updated_at AS "cardUpdatedAt",
      (SELECT string_agg(t.full_name, ', ') FROM tutor_students ts JOIN tutors t ON t.id = ts.tutor_id WHERE ts.student_id = s.id) AS "tutors"
      FROM students s LEFT JOIN student_cards sc ON sc.student_id = s.id ORDER BY s.full_name LIMIT $1 OFFSET $2`, [limit, offset]);
  }
  async getStudentForAdmin(studentId) { return this.one(`SELECT s.id, s.full_name AS "fullName", s.subject, s.grade, s.status, s.my_klass_id AS "myKlassId", s.last_lesson_at AS "lastLessonAt" FROM students s WHERE s.id = $1`, [studentId]); }
  // Cards never updated within `days` (spec 5.2 "видеть, какие карточки не
  // обновлялись"). Newest-stale first so the worst offenders surface last-page-free.
  async listStaleCards(days = 14, { limit = 50, offset = 0 } = {}) {
    return this.rows(`SELECT s.id, s.full_name AS "fullName", s.subject, s.grade, sc.updated_at AS "cardUpdatedAt"
      FROM student_cards sc JOIN students s ON s.id = sc.student_id
      WHERE sc.updated_at < NOW() - ($1 * INTERVAL '1 day') AND s.status = 'active'
      ORDER BY sc.updated_at ASC LIMIT $2 OFFSET $3`, [days, limit, offset]);
  }
  async getCard(studentId) { return this.one(`SELECT student_id AS "studentId", current_level AS "currentLevel", topics, strengths, weaknesses, gaps, recommendations, learning_goal AS "learningGoal", learning_pace AS "learningPace", features, next_lesson_plan AS "nextLessonPlan", topics_updated_at AS "topicsUpdatedAt", source_transcript_ids AS "sourceTranscriptIds", updated_at AS "updatedAt" FROM student_cards WHERE student_id = $1`, [studentId]); }
  async listHistory(studentId) { return this.rows(`SELECT id, source, changes, created_at AS "createdAt" FROM card_history WHERE student_id = $1 ORDER BY id DESC`, [studentId]); }
  async getTranscript(id, tutorId) { return this.one(`SELECT id, student_id AS "studentId", tutor_id AS "tutorId", lesson_date AS "lessonDate", text, status, analysis_result AS "analysisResult", created_at AS "createdAt" FROM transcripts WHERE id = $1 AND tutor_id = $2`, [id, tutorId]); }
  async listTranscripts(studentId, tutorId, { limit = null, offset = 0 } = {}) {
    const values = [studentId, tutorId];
    let paging = "";
    if (limit != null) {
      values.push(limit, offset);
      paging = ` LIMIT $3 OFFSET $4`;
    }
    return this.rows(`SELECT id, student_id AS "studentId", tutor_id AS "tutorId", lesson_date AS "lessonDate", text, status, analysis_result AS "analysisResult", created_at AS "createdAt" FROM transcripts WHERE student_id = $1 AND tutor_id = $2 ORDER BY lesson_date DESC, id DESC${paging}`, values);
  }
  async listRecentLessons(studentId, limit = 4, offset = 0) { return this.rows(`SELECT my_klass_lesson_id AS "myKlassLessonId", lesson_date AS "lessonDate", topic FROM my_klass_lessons WHERE student_id = $1 AND lesson_date <= CURRENT_DATE ORDER BY lesson_date DESC, my_klass_lesson_id DESC LIMIT $2 OFFSET $3`, [studentId, limit, offset]); }
  async getUpcomingLesson(studentId) { return this.one(`SELECT my_klass_lesson_id AS "myKlassLessonId", lesson_date AS "lessonDate", topic FROM my_klass_lessons WHERE student_id = $1 AND lesson_date > CURRENT_DATE ORDER BY lesson_date ASC, my_klass_lesson_id ASC LIMIT 1`, [studentId]); }
  async getDraft(id, tutorId) { return this.one(`SELECT id, transcript_id AS "transcriptId", student_id AS "studentId", tutor_id AS "tutorId", changes, status, created_at AS "createdAt", updated_at AS "updatedAt", approved_at AS "approvedAt" FROM analysis_drafts WHERE id = $1 AND tutor_id = $2`, [id, tutorId]); }
  async getDraftByTranscript(transcriptId, tutorId) { return this.one(`SELECT id, transcript_id AS "transcriptId", student_id AS "studentId", tutor_id AS "tutorId", changes, status, created_at AS "createdAt", updated_at AS "updatedAt", approved_at AS "approvedAt" FROM analysis_drafts WHERE transcript_id = $1 AND tutor_id = $2`, [transcriptId, tutorId]); }
  async getProfileDraft(id, tutorId) { return this.one(`SELECT id, student_id AS "studentId", tutor_id AS "tutorId", changes, source_transcript_ids AS "sourceTranscriptIds", missing_fields AS "missingFields", status, created_at AS "createdAt", updated_at AS "updatedAt", approved_at AS "approvedAt" FROM profile_analysis_drafts WHERE id = $1 AND tutor_id = $2`, [id, tutorId]); }

  async updateCard(studentId, tutorId, patch, source = "manual", client = null) {
    if (client) return this.updateCardLocked(client, studentId, tutorId, patch, source);
    const own = await this.pool.connect();
    try {
      await own.query("BEGIN");
      const card = await this.updateCardLocked(own, studentId, tutorId, patch, source);
      await own.query("COMMIT");
      return card;
    } catch (error) {
      await own.query("ROLLBACK");
      throw error;
    } finally {
      own.release();
    }
  }

  // Requires an open transaction on `client`: the row lock serializes concurrent
  // read-merge-write cycles so parallel edits cannot silently drop each other.
  async updateCardLocked(client, studentId, tutorId, patch, source) {
    const locked = await client.query(`SELECT student_id AS "studentId", current_level AS "currentLevel", topics, strengths, weaknesses, gaps, recommendations, learning_goal AS "learningGoal", learning_pace AS "learningPace", features, next_lesson_plan AS "nextLessonPlan" FROM student_cards WHERE student_id = $1 FOR UPDATE`, [studentId]);
    const current = locked.rows[0];
    if (!current) throw new Error("Student card not found");
    const next = { ...current, ...patch };
    const result = await client.query(`UPDATE student_cards SET current_level = $1, topics = $2, strengths = $3, weaknesses = $4, gaps = $5, recommendations = $6, learning_goal = $7, learning_pace = $8, features = $9, next_lesson_plan = $10, updated_at = NOW() WHERE student_id = $11 RETURNING student_id AS "studentId", current_level AS "currentLevel", topics, strengths, weaknesses, gaps, recommendations, learning_goal AS "learningGoal", learning_pace AS "learningPace", features, next_lesson_plan AS "nextLessonPlan", updated_at AS "updatedAt"`, [next.currentLevel || null, JSON.stringify(next.topics || []), JSON.stringify(next.strengths || []), JSON.stringify(next.weaknesses || []), JSON.stringify(next.gaps || []), JSON.stringify(next.recommendations || []), next.learningGoal || null, next.learningPace || null, next.features || null, next.nextLessonPlan || null, studentId]);
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
    return this.one(`INSERT INTO ai_analysis_logs (transcript_id, student_id, tutor_id, provider, model, status, input_tokens, output_tokens, total_tokens, estimated_cost_usd, duration_ms, raw_response, error_message)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id, status, provider, model, input_tokens AS "inputTokens", output_tokens AS "outputTokens", total_tokens AS "totalTokens", estimated_cost_usd AS "estimatedCostUsd", duration_ms AS "durationMs", created_at AS "createdAt"`, [transcriptId, studentId, tutorId, provider, model, status, inputTokens, outputTokens, totalTokens, estimatedCostUsd, durationMs, rawResponse, errorMessage]);
  }

  async updateDraft(id, tutorId, changes) {
    const draft = await this.getDraft(id, tutorId);
    if (!draft || draft.status !== "draft") return null;
    await this.pool.query("UPDATE analysis_drafts SET changes = $1, updated_at = NOW() WHERE id = $2", [JSON.stringify({ ...draft.changes, ...changes }), id]);
    return this.getDraft(id, tutorId);
  }

  async createProfileDraft({ studentId, tutorId, changes, sourceTranscriptIds, missingFields }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE profile_analysis_drafts SET status = 'rejected', updated_at = NOW() WHERE student_id = $1 AND tutor_id = $2 AND status = 'draft'", [studentId, tutorId]);
      const result = await client.query(`INSERT INTO profile_analysis_drafts (student_id, tutor_id, changes, source_transcript_ids, missing_fields)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, student_id AS "studentId", tutor_id AS "tutorId", changes, source_transcript_ids AS "sourceTranscriptIds", missing_fields AS "missingFields", status, created_at AS "createdAt", updated_at AS "updatedAt", approved_at AS "approvedAt"`, [studentId, tutorId, JSON.stringify(changes), sourceTranscriptIds, JSON.stringify(missingFields)]);
      await client.query("COMMIT");
      return result.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateProfileDraft(id, tutorId, changes) {
    const draft = await this.getProfileDraft(id, tutorId);
    if (!draft || draft.status !== "draft") return null;
    const next = { ...draft.changes, ...changes };
    const missingFields = Object.entries(next)
      .filter(([, value]) => Array.isArray(value) ? value.length === 0 : !String(value || "").trim())
      .map(([field]) => field);
    await this.pool.query("UPDATE profile_analysis_drafts SET changes = $1, missing_fields = $2, updated_at = NOW() WHERE id = $3 AND tutor_id = $4 AND status = 'draft'", [JSON.stringify(next), JSON.stringify(missingFields), id, tutorId]);
    return this.getProfileDraft(id, tutorId);
  }

  async rejectProfileDraft(id, tutorId) {
    return this.one(`UPDATE profile_analysis_drafts SET status = 'rejected', updated_at = NOW()
      WHERE id = $1 AND tutor_id = $2 AND status = 'draft'
      RETURNING id, student_id AS "studentId", tutor_id AS "tutorId", changes, source_transcript_ids AS "sourceTranscriptIds", missing_fields AS "missingFields", status, created_at AS "createdAt", updated_at AS "updatedAt", approved_at AS "approvedAt"`, [id, tutorId]);
  }

  async approveProfileDraft(id, tutorId) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(`SELECT id, student_id AS "studentId", changes, source_transcript_ids AS "sourceTranscriptIds", status FROM profile_analysis_drafts WHERE id = $1 AND tutor_id = $2 FOR UPDATE`, [id, tutorId]);
      const draft = result.rows[0];
      if (!draft || draft.status !== "draft") { await client.query("COMMIT"); return null; }
      await this.updateCard(draft.studentId, tutorId, draft.changes, "deep_analysis", client);
      await client.query(`UPDATE student_cards
        SET topics_updated_at = NOW(),
            source_transcript_ids = ARRAY(
              SELECT DISTINCT transcript_id
              FROM unnest(source_transcript_ids || $1::bigint[]) AS transcript_id
              ORDER BY transcript_id
            )
        WHERE student_id = $2`, [draft.sourceTranscriptIds || [], draft.studentId]);
      await client.query("UPDATE profile_analysis_drafts SET status = 'approved', approved_at = NOW(), updated_at = NOW() WHERE id = $1", [id]);
      await client.query("COMMIT");
      return this.getProfileDraft(id, tutorId);
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
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
      const lastLessonAt = /^\d{4}-\d{2}-\d{2}$/.test(draft.changes.lessonDate || "") ? draft.changes.lessonDate : new Date().toISOString().slice(0, 10);
      await client.query("UPDATE students SET last_lesson_at = $1 WHERE id = $2", [lastLessonAt, draft.studentId]);
      await client.query("COMMIT");
      return this.getDraft(id, tutorId);
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
}

class GenerationRepository extends Repository {
  async create({ type, studentId, tutorId, topic, inputParams = {}, result, parentId = null }) { return this.one(`INSERT INTO generations (type, student_id, tutor_id, topic, input_params, result, parent_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, type, student_id AS "studentId", tutor_id AS "tutorId", topic, input_params AS "inputParams", result, status, parent_id AS "parentId", created_at AS "createdAt"`, [type, studentId, tutorId, topic, JSON.stringify(inputParams), result, parentId]); }
  async get(id, tutorId) { return this.one(`SELECT id, type, student_id AS "studentId", tutor_id AS "tutorId", topic, input_params AS "inputParams", result, status, parent_id AS "parentId", created_at AS "createdAt" FROM generations WHERE id = $1 AND tutor_id = $2`, [id, tutorId]); }
  async createFeedback({ generationId, tutorId, rating, reason = null }) { if (!await this.get(generationId, tutorId)) return null; return this.one(`INSERT INTO generation_feedback (generation_id, tutor_id, rating, reason) VALUES ($1, $2, $3, $4) RETURNING id, generation_id AS "generationId", tutor_id AS "tutorId", rating, reason, created_at AS "createdAt"`, [generationId, tutorId, rating, reason]); }
  // Admin generation log (spec 20.6 "выгрузка логов генераций"): newest first,
  // joined to tutor and student names for a readable list.
  async listForAdmin({ limit = 20, offset = 0 } = {}) {
    return this.rows(`SELECT g.id, g.type, g.topic, g.status, g.created_at AS "createdAt",
      t.full_name AS "tutorName", s.full_name AS "studentName"
      FROM generations g JOIN tutors t ON t.id = g.tutor_id JOIN students s ON s.id = g.student_id
      ORDER BY g.created_at DESC, g.id DESC LIMIT $1 OFFSET $2`, [limit, offset]);
  }
}

class MaterialsRepository extends Repository {
  async upsert({ mtsFileId, name, category, grade, subject, topic, materialType, url }) { await this.pool.query(`INSERT INTO materials (mts_file_id, name, category, grade, subject, topic, material_type, url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (mts_file_id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, grade = EXCLUDED.grade, subject = EXCLUDED.subject, topic = EXCLUDED.topic, material_type = EXCLUDED.material_type, url = EXCLUDED.url, synced_at = NOW()`, [mtsFileId, name, category, grade, subject, topic, materialType, url]); }
  async search({ query, subject, grade, limit = 10 }) {
    const conditions = [];
    const values = [];
    // "8 класс" in the query is a grade filter, not a text token.
    let text = String(query || "");
    const gradeMatch = text.match(/\b(1[01]|[1-9])\s*(?:класс|кл\.?)\b/i);
    if (gradeMatch) {
      if (!grade) grade = Number(gradeMatch[1]);
      text = text.replace(gradeMatch[0], " ");
    }
    // Tokenized match: every word must hit name, topic, subject or type, so
    // queries like "квадратные уравнения тест" still find "Квадратные уравнения".
    for (const word of text.split(/\s+/).filter(Boolean).slice(0, 8)) {
      values.push(`%${word}%`);
      conditions.push(`(name ILIKE $${values.length} OR topic ILIKE $${values.length} OR subject ILIKE $${values.length} OR material_type ILIKE $${values.length})`);
    }
    if (subject) { values.push(subject); conditions.push(`subject ILIKE $${values.length}`); }
    if (grade) { values.push(grade); conditions.push(`grade = $${values.length}`); }
    values.push(limit);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.rows(`SELECT id, name, category, grade, subject, topic, material_type AS "materialType", url FROM materials ${where} ORDER BY grade NULLS LAST, subject, name LIMIT $${values.length}`, values);
  }

  // --- Admin metadata editing (spec 20.5) ---
  async list({ limit = 20, offset = 0 } = {}) {
    return this.rows(`SELECT id, name, category, grade, subject, topic, material_type AS "materialType", url FROM materials ORDER BY subject, grade NULLS LAST, name LIMIT $1 OFFSET $2`, [limit, offset]);
  }
  async getById(id) { return this.one(`SELECT id, name, category, grade, subject, topic, material_type AS "materialType", url FROM materials WHERE id = $1`, [id]); }
  // Whitelisted metadata fields only (spec 11.6): name, subject, grade, topic,
  // material type, url. mts_file_id/category stay owned by the MTS sync.
  async updateMetadata(id, patch) {
    const columns = { name: "name", subject: "subject", grade: "grade", topic: "topic", materialType: "material_type", url: "url" };
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (patch[key] === undefined) continue;
      values.push(patch[key] === "" ? null : patch[key]);
      sets.push(`${column} = $${values.length}`);
    }
    if (!sets.length) return this.getById(id);
    values.push(id);
    return this.one(`UPDATE materials SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING id, name, category, grade, subject, topic, material_type AS "materialType", url`, values);
  }
}

class IntegrationRepository extends Repository {
  constructor(pool, learning) { super(pool); this.learning = learning; }
  async getMtsSession(eventSessionId) { return this.one(`SELECT event_session_id AS "eventSessionId", my_klass_lesson_id AS "myKlassLessonId", student_id AS "studentId", tutor_id AS "tutorId", synced_at AS "syncedAt" FROM mts_link_sessions WHERE event_session_id = $1`, [String(eventSessionId)]); }
  async getMtsWebhook(transcriptId) { return this.one(`SELECT transcript_id AS "transcriptId", event_session_id AS "eventSessionId", local_transcript_id AS "localTranscriptId", status, raw_payload AS "rawPayload", error_message AS "errorMessage", received_at AS "receivedAt", updated_at AS "updatedAt" FROM mts_link_webhooks WHERE transcript_id = $1`, [String(transcriptId)]); }
  async linkMtsSession({ eventSessionId, myKlassLessonId, studentId, tutorId }) { if (!await this.learning.getStudent(studentId, tutorId)) return null; await this.pool.query(`INSERT INTO mts_link_sessions (event_session_id, my_klass_lesson_id, student_id, tutor_id) VALUES ($1, $2, $3, $4) ON CONFLICT(event_session_id) DO UPDATE SET my_klass_lesson_id = EXCLUDED.my_klass_lesson_id, student_id = EXCLUDED.student_id, tutor_id = EXCLUDED.tutor_id, synced_at = NOW()`, [String(eventSessionId), myKlassLessonId ? String(myKlassLessonId) : null, studentId, tutorId]); return this.getMtsSession(eventSessionId); }
  async registerMtsWebhook({ transcriptId, eventSessionId, payload }) { await this.pool.query(`INSERT INTO mts_link_webhooks (transcript_id, event_session_id, status, raw_payload) VALUES ($1, $2, 'received', $3) ON CONFLICT(transcript_id) DO NOTHING`, [String(transcriptId), String(eventSessionId), JSON.stringify(payload)]); return this.getMtsWebhook(transcriptId); }
  async updateMtsWebhook(transcriptId, { status, localTranscriptId = null, errorMessage = null }) { await this.pool.query("UPDATE mts_link_webhooks SET status = $1, local_transcript_id = COALESCE($2, local_transcript_id), error_message = $3, updated_at = NOW() WHERE transcript_id = $4", [status, localTranscriptId, errorMessage, String(transcriptId)]); return this.getMtsWebhook(transcriptId); }
  // Integration errors for the admin panel (spec 20.3, 5.2 "видеть ошибки
  // интеграции"): MTS Link webhooks that failed to map or process, newest first.
  async listErrors({ limit = 20, offset = 0 } = {}) {
    return this.rows(`SELECT transcript_id AS "transcriptId", event_session_id AS "eventSessionId", status, error_message AS "errorMessage", received_at AS "receivedAt", updated_at AS "updatedAt" FROM mts_link_webhooks WHERE status IN ('unmapped', 'failed') ORDER BY updated_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
  }
  async syncMoyKlassLesson({ myKlassLessonId, tutorId, studentId, lessonDate, topic, description, payload }) {
    const existing = await this.one(`SELECT my_klass_lesson_id AS "myKlassLessonId", transcript_created AS "transcriptCreated" FROM my_klass_lessons WHERE my_klass_lesson_id = $1`, [myKlassLessonId]);
    if (existing) {
      // Future lessons get re-synced after they happen: refresh the row so the
      // topic/date reflect the completed lesson.
      await this.pool.query("UPDATE my_klass_lessons SET lesson_date = $2, topic = $3, source_payload = $4 WHERE my_klass_lesson_id = $1", [myKlassLessonId, lessonDate, topic, JSON.stringify(payload)]);
    } else {
      await this.pool.query(`INSERT INTO my_klass_lessons (my_klass_lesson_id, tutor_id, student_id, lesson_date, topic, source_payload) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (my_klass_lesson_id) DO NOTHING`, [myKlassLessonId, tutorId, studentId, lessonDate, topic, JSON.stringify(payload)]);
    }
    const hasDescription = Boolean(String(description || "").trim());
    // MTS Link delivers the real transcript for these lessons via webhook.
    const mtsSession = hasDescription ? await this.one("SELECT event_session_id FROM mts_link_sessions WHERE my_klass_lesson_id = $1", [myKlassLessonId]) : null;
    if (!hasDescription || mtsSession) return { created: !existing, transcriptCreated: false };

    // Atomically claim transcript creation so concurrent "Обновить учеников"
    // runs (double-tap / overlapping /login+/refresh) cannot insert duplicates.
    const claimed = await this.one(
      `UPDATE my_klass_lessons SET transcript_created = TRUE
       WHERE my_klass_lesson_id = $1 AND transcript_created = FALSE
       RETURNING my_klass_lesson_id AS "myKlassLessonId"`,
      [myKlassLessonId]
    );
    if (!claimed) return { created: !existing, transcriptCreated: false };

    try {
      await this.learning.createTranscript({ studentId, tutorId, lessonDate, text: topic ? `Тема: ${topic}\n${description}` : description });
    } catch (error) {
      await this.pool.query("UPDATE my_klass_lessons SET transcript_created = FALSE WHERE my_klass_lesson_id = $1", [myKlassLessonId]);
      throw error;
    }
    return { created: !existing, transcriptCreated: true };
  }
}

class MetricsRepository extends Repository {
  async logUsageEvent({ eventType, tutorId = null, meta = {} }) { await this.pool.query("INSERT INTO usage_events (event_type, tutor_id, meta) VALUES ($1, $2, $3)", [eventType, tutorId, JSON.stringify(meta)]); }
  async getMetrics() { const [activeTutors, generationsByType, regenerations, feedback, usageByType, transcriptsAnalyzed, cardUpdates] = await Promise.all([this.one(`SELECT COUNT(DISTINCT tutor_id)::int AS count FROM usage_events WHERE created_at > NOW() - INTERVAL '30 days'`), this.rows(`SELECT type, COUNT(*)::int AS count FROM generations GROUP BY type ORDER BY type`), this.one(`SELECT COUNT(*)::int AS total, COUNT(parent_id)::int AS adjusted FROM generations`), this.rows(`SELECT rating, reason, COUNT(*)::int AS count FROM generation_feedback GROUP BY rating, reason ORDER BY rating, reason`), this.rows(`SELECT event_type AS "eventType", COUNT(*)::int AS count FROM usage_events GROUP BY event_type ORDER BY event_type`), this.one(`SELECT COUNT(*)::int AS count FROM transcripts WHERE status IN ('analyzed', 'approved')`), this.rows(`SELECT source, COUNT(*)::int AS count FROM card_history GROUP BY source ORDER BY source`)]); return { activeTutorsLast30Days: activeTutors.count, generationsByType, regenerationShare: regenerations.total ? Number((regenerations.adjusted / regenerations.total).toFixed(2)) : 0, feedback, usageEvents: usageByType, transcriptsAnalyzed: transcriptsAnalyzed.count, cardUpdatesBySource: cardUpdates }; }
}

class TelegramSessionRepository extends Repository {
  async set(telegramUserId, data, ttlSeconds) { await this.pool.query("DELETE FROM telegram_sessions WHERE expires_at <= NOW()"); await this.pool.query(`INSERT INTO telegram_sessions (telegram_user_id, data, expires_at) VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 second')) ON CONFLICT (telegram_user_id) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at, updated_at = NOW()`, [String(telegramUserId), JSON.stringify(data), ttlSeconds]); }
  async get(telegramUserId) {
    const session = await this.one("SELECT data, expires_at <= NOW() AS expired FROM telegram_sessions WHERE telegram_user_id = $1", [String(telegramUserId)]);
    if (!session) return null;
    if (session.expired) {
      await this.delete(telegramUserId);
      // Marker lets the bot explain the timeout instead of silently rerouting
      // the reply into the freeform assistant.
      return { expired: true };
    }
    return session.data;
  }
  async delete(telegramUserId) { await this.pool.query("DELETE FROM telegram_sessions WHERE telegram_user_id = $1", [String(telegramUserId)]); }
}

module.exports = { TutorRepository, LearningRepository, GenerationRepository, MaterialsRepository, IntegrationRepository, MetricsRepository, TelegramSessionRepository };
