const path = require("node:path");
const { Pool } = require("pg");
const { runMigrations } = require("./database/migration-runner");
const {
  TutorRepository,
  LearningRepository,
  GenerationRepository,
  MaterialsRepository,
  IntegrationRepository,
  MetricsRepository,
  TelegramSessionRepository,
} = require("./database/repositories");

function isLocalDatabase(connectionString) {
  try {
    return ["localhost", "127.0.0.1", "::1"].includes(new URL(connectionString).hostname);
  } catch {
    return false;
  }
}

class PostgresDatabase {
  constructor(connectionString) {
    this.pool = new Pool({
      connectionString,
      ssl: isLocalDatabase(connectionString) ? false : { rejectUnauthorized: false },
    });
    this.tutors = new TutorRepository(this.pool);
    this.learning = new LearningRepository(this.pool);
    this.generations = new GenerationRepository(this.pool);
    this.materials = new MaterialsRepository(this.pool);
    this.integrations = new IntegrationRepository(this.pool, this.learning);
    this.metrics = new MetricsRepository(this.pool);
    this.telegramSessions = new TelegramSessionRepository(this.pool);
  }

  async initialize() {
    await runMigrations(this.pool, path.join(__dirname, "..", "db", "migrations"));
    // Demo data is opt-in: a publicly known demo email must not become a login
    // on a production database that happens to start empty.
    if (process.env.SEED_DEMO_DATA === "true") {
      const { rows } = await this.pool.query("SELECT COUNT(*)::int AS count FROM tutors");
      if (rows[0].count === 0) await this.seedDemoData();
    }
  }

  async ping() {
    await this.pool.query("SELECT 1");
  }

  async seedDemoData() {
    const tutor = await this.pool.query(
      "INSERT INTO tutors (full_name, email) VALUES ($1, $2) RETURNING id",
      ["Демо-репетитор", "demo@edme.local"],
    );
    const tutorId = tutor.rows[0].id;
    const students = [
      ["Иван Петров", "Математика", 8, "demo-mk-001", "средний", "Уверенно освоить алгебру за 8 класс"],
      ["Анна Сидорова", "Физика", 9, "demo-mk-002", "средний", "Подготовиться к контрольной по механике"],
    ];
    for (const student of students) {
      // `name` mirrors `full_name`: see the comment on upsertMoyKlassStudent
      // about the shared students table having a legacy NOT NULL `name` column.
      const result = await this.pool.query(
        "INSERT INTO students (full_name, name, subject, grade, my_class_id, tutor_id) VALUES ($1, $1, $2, $3, $4, $5) RETURNING id",
        [...student.slice(0, 4), tutorId],
      );
      await this.pool.query(
        "INSERT INTO student_cards (student_id, current_level, learning_goal) VALUES ($1, $2, $3)",
        [result.rows[0].id, student[4], student[5]],
      );
      await this.tutors.linkStudent(tutorId, result.rows[0].id, { subject: student[1], grade: student[2] });
    }
  }

  getTutorByTelegramId(...args) { return this.tutors.getByTelegramId(...args); }
  getTutorByPhone(...args) { return this.tutors.getByPhone(...args); }
  bindTutorTelegramId(...args) { return this.tutors.bindTelegramId(...args); }
  unbindTutorTelegramId(...args) { return this.tutors.unbindTelegramId(...args); }
  upsertMoyKlassTutor(...args) { return this.tutors.upsertMoyKlassTutor(...args); }
  upsertMoyKlassStudent(...args) { return this.tutors.upsertMoyKlassStudent(...args); }
  linkTutorStudent(...args) { return this.tutors.linkStudent(...args); }
  unlinkTutorStudentByMyKlassId(...args) { return this.tutors.unlinkStudentByMyKlassId(...args); }
  pruneTutorStudents(...args) { return this.tutors.pruneStudents(...args); }

  // Admin panel (spec section 20)
  ensureBootstrapAdmin(...args) { return this.tutors.ensureBootstrapAdmin(...args); }
  setTutorAdminByPhone(...args) { return this.tutors.setAdminByPhone(...args); }
  setTutorActive(...args) { return this.tutors.setActive(...args); }
  listTutors(...args) { return this.tutors.list(...args); }
  getTutorForAdmin(...args) { return this.tutors.getForAdmin(...args); }
  getTutorForAdminByPhone(...args) { return this.tutors.getForAdminByPhone(...args); }
  listAllStudents(...args) { return this.learning.listAllStudents(...args); }
  getStudentForAdmin(...args) { return this.learning.getStudentForAdmin(...args); }
  listStaleCards(...args) { return this.learning.listStaleCards(...args); }
  listGenerationsForAdmin(...args) { return this.generations.listForAdmin(...args); }
  listMaterialsForAdmin(...args) { return this.materials.list(...args); }
  getMaterial(...args) { return this.materials.getById(...args); }
  updateMaterialMetadata(...args) { return this.materials.updateMetadata(...args); }
  listIntegrationErrors(...args) { return this.integrations.listErrors(...args); }

  listStudents(...args) { return this.learning.listStudents(...args); }
  getStudent(...args) { return this.learning.getStudent(...args); }
  getCard(...args) { return this.learning.getCard(...args); }
  listHistory(...args) { return this.learning.listHistory(...args); }
  getTranscript(...args) { return this.learning.getTranscript(...args); }
  listTranscripts(...args) { return this.learning.listTranscripts(...args); }
  listRecentLessons(...args) { return this.learning.listRecentLessons(...args); }
  getUpcomingLesson(...args) { return this.learning.getUpcomingLesson(...args); }
  getDraft(...args) { return this.learning.getDraft(...args); }
  getDraftByTranscript(...args) { return this.learning.getDraftByTranscript(...args); }
  getProfileDraft(...args) { return this.learning.getProfileDraft(...args); }
  updateCard(...args) { return this.learning.updateCard(...args); }
  createTranscript(...args) { return this.learning.createTranscript(...args); }
  saveAnalysis(...args) { return this.learning.saveAnalysis(...args); }
  createAiAnalysisLog(...args) { return this.learning.createAiAnalysisLog(...args); }
  updateDraft(...args) { return this.learning.updateDraft(...args); }
  approveDraft(...args) { return this.learning.approveDraft(...args); }
  createProfileDraft(...args) { return this.learning.createProfileDraft(...args); }
  updateProfileDraft(...args) { return this.learning.updateProfileDraft(...args); }
  approveProfileDraft(...args) { return this.learning.approveProfileDraft(...args); }
  rejectProfileDraft(...args) { return this.learning.rejectProfileDraft(...args); }

  createGeneration(...args) { return this.generations.create(...args); }
  getGeneration(...args) { return this.generations.get(...args); }
  createGenerationFeedback(...args) { return this.generations.createFeedback(...args); }
  upsertMaterial(...args) { return this.materials.upsert(...args); }
  searchMaterials(...args) { return this.materials.search(...args); }
  getMtsSession(...args) { return this.integrations.getMtsSession(...args); }
  getMtsWebhook(...args) { return this.integrations.getMtsWebhook(...args); }
  linkMtsSession(...args) { return this.integrations.linkMtsSession(...args); }
  registerMtsWebhook(...args) { return this.integrations.registerMtsWebhook(...args); }
  updateMtsWebhook(...args) { return this.integrations.updateMtsWebhook(...args); }
  syncMoyKlassLesson(...args) { return this.integrations.syncMoyKlassLesson(...args); }
  logUsageEvent(...args) { return this.metrics.logUsageEvent(...args); }
  getMetrics(...args) { return this.metrics.getMetrics(...args); }

  setTelegramSession(...args) { return this.telegramSessions.set(...args); }
  getTelegramSession(...args) { return this.telegramSessions.get(...args); }
  deleteTelegramSession(...args) { return this.telegramSessions.delete(...args); }
  async close() { await this.pool.end(); }
}

module.exports = { PostgresDatabase, isLocalDatabase };
