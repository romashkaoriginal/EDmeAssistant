const express = require("express");
const cors = require("cors");
const { z } = require("zod");
const { runLessonAnalysis } = require("./analysis-runner");

const idSchema = z.coerce.number().int().positive();
const tutorIdSchema = z.coerce.number().int().positive();
const cardPatchSchema = z.object({
  currentLevel: z.string().max(100).optional(),
  strengths: z.array(z.string().max(500)).optional(),
  weaknesses: z.array(z.string().max(500)).optional(),
  gaps: z.array(z.string().max(500)).optional(),
  recommendations: z.array(z.string().max(1000)).optional(),
  learningGoal: z.string().max(1000).nullable().optional(),
  learningPace: z.string().max(100).nullable().optional(),
  features: z.string().max(2000).nullable().optional(),
  nextLessonPlan: z.string().max(2000).nullable().optional(),
});
const transcriptSchema = z.object({
  tutorId: tutorIdSchema,
  lessonDate: z.string().date(),
  text: z.string().trim().min(20).max(20000),
});
const mtsSessionSchema = z.object({
  tutorId: tutorIdSchema,
  eventSessionId: z.union([z.string().min(1), z.number().int().positive()]),
  myKlassLessonId: z.union([z.string().min(1), z.number().int().positive()]).optional(),
});
const mtsWebhookSchema = z.object({
  event: z.enum(["transcript.ready", "transcription.ready"]),
  data: z.object({ transcriptId: z.union([z.string().min(1), z.number().int().positive()]), eventSessionId: z.union([z.string().min(1), z.number().int().positive()]) }),
});

function parseOrThrow(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const error = new Error(result.error.issues.map((issue) => issue.message).join("; "));
  error.status = 400;
  throw error;
}

function createApp({ database, analyzer, mtsLink, moyKlass, telegramBot, telegramWebhookSecret, moyKlassSyncSecret }) {
  const app = express();
  app.use(cors());
  app.use(express.json({
    limit: "100kb",
    verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); },
  }));

  if (telegramBot) {
    app.post("/webhooks/telegram", (req, res) => {
      if (telegramWebhookSecret && req.get("x-telegram-bot-api-secret-token") !== telegramWebhookSecret) {
        return res.status(401).json({ error: "Invalid Telegram webhook secret" });
      }
      res.sendStatus(200);
      setImmediate(() => Promise.resolve(telegramBot.processUpdate(req.body)).catch((error) => console.error("Telegram update failed", error)));
    });
  }

  app.get("/", (_req, res) => res.json({ message: "EDmeAssistant backend is running", health: "/health" }));
  app.get("/health", (_req, res) => res.json({ ok: true, service: "EDmeAssistant backend", aiConfigured: analyzer.isConfigured(), timestamp: new Date().toISOString() }));

  app.post("/api/moy-klass/sync", async (req, res, next) => {
    try {
      if (!moyKlass?.isConfigured()) return res.status(503).json({ error: "Moy Klass is not configured" });
      if (!moyKlassSyncSecret || req.get("x-moy-klass-sync-secret") !== moyKlassSyncSecret) return res.status(401).json({ error: "Invalid sync secret" });
      return res.json({ sync: await moyKlass.sync(database) });
    } catch (error) { return next(error); }
  });

  app.get("/api/students", async (req, res, next) => {
    try { res.json({ students: await database.listStudents(parseOrThrow(tutorIdSchema, req.query.tutorId)) }); } catch (error) { next(error); }
  });

  app.get("/api/students/:studentId", async (req, res, next) => {
    try {
      const studentId = parseOrThrow(idSchema, req.params.studentId);
      const tutorId = parseOrThrow(tutorIdSchema, req.query.tutorId);
      const student = await database.getStudent(studentId, tutorId);
      if (!student) return res.status(404).json({ error: "Student not found" });
      return res.json({ student, card: await database.getCard(studentId) });
    } catch (error) { return next(error); }
  });

  app.patch("/api/students/:studentId/card", async (req, res, next) => {
    try {
      const studentId = parseOrThrow(idSchema, req.params.studentId);
      const tutorId = parseOrThrow(tutorIdSchema, req.body.tutorId);
      if (!await database.getStudent(studentId, tutorId)) return res.status(404).json({ error: "Student not found" });
      return res.json({ card: await database.updateCard(studentId, tutorId, parseOrThrow(cardPatchSchema, req.body)) });
    } catch (error) { return next(error); }
  });

  app.get("/api/students/:studentId/history", async (req, res, next) => {
    try {
      const studentId = parseOrThrow(idSchema, req.params.studentId);
      const tutorId = parseOrThrow(tutorIdSchema, req.query.tutorId);
      if (!await database.getStudent(studentId, tutorId)) return res.status(404).json({ error: "Student not found" });
      return res.json({ history: await database.listHistory(studentId) });
    } catch (error) { return next(error); }
  });

  app.get("/api/students/:studentId/transcripts", async (req, res, next) => {
    try {
      const studentId = parseOrThrow(idSchema, req.params.studentId);
      const tutorId = parseOrThrow(tutorIdSchema, req.query.tutorId);
      if (!await database.getStudent(studentId, tutorId)) return res.status(404).json({ error: "Student not found" });
      return res.json({ transcripts: await database.listTranscripts(studentId, tutorId) });
    } catch (error) { return next(error); }
  });

  app.post("/api/students/:studentId/transcripts", async (req, res, next) => {
    try {
      const studentId = parseOrThrow(idSchema, req.params.studentId);
      const input = parseOrThrow(transcriptSchema, req.body);
      if (!await database.getStudent(studentId, input.tutorId)) return res.status(404).json({ error: "Student not found" });
      return res.status(201).json({ transcript: await database.createTranscript({ studentId, ...input }) });
    } catch (error) { return next(error); }
  });

  app.post("/api/students/:studentId/mts-link-sessions", async (req, res, next) => {
    try {
      const studentId = parseOrThrow(idSchema, req.params.studentId);
      const input = parseOrThrow(mtsSessionSchema, req.body);
      const session = await database.linkMtsSession({ studentId, ...input });
      if (!session) return res.status(404).json({ error: "Student not found" });
      return res.status(201).json({ session });
    } catch (error) { return next(error); }
  });

  app.post("/webhooks/mts-link", async (req, res, next) => {
    try {
      if (!mtsLink || !mtsLink.verifyWebhook(req)) return res.status(401).json({ error: "Invalid webhook secret" });
      const event = parseOrThrow(mtsWebhookSchema, req.body);
      const webhook = await database.registerMtsWebhook({
        transcriptId: event.data.transcriptId,
        eventSessionId: event.data.eventSessionId,
        payload: req.body,
      });
      res.status(200).json({ accepted: true, transcriptId: webhook.transcriptId });
      setImmediate(() => mtsLink.processTranscriptReady(webhook.transcriptId).catch((error) => console.error("MTS Link sync failed", error)));
    } catch (error) { next(error); }
  });

  app.post("/api/transcripts/:transcriptId/analyze", async (req, res, next) => {
    try {
      const transcriptId = parseOrThrow(idSchema, req.params.transcriptId);
      const tutorId = parseOrThrow(tutorIdSchema, req.body.tutorId);
      const transcript = await database.getTranscript(transcriptId, tutorId);
      if (!transcript) return res.status(404).json({ error: "Transcript not found" });
      const student = await database.getStudent(transcript.studentId, tutorId);
      const draft = await runLessonAnalysis({ analyzer, database, transcript, student, tutorId });
      return res.status(201).json({ draft });
    } catch (error) { return next(error); }
  });

  app.get("/api/mts-link/webhooks/:transcriptId", async (req, res, next) => {
    try {
      const webhook = await database.getMtsWebhook(req.params.transcriptId);
      if (!webhook) return res.status(404).json({ error: "Webhook event not found" });
      return res.json({ webhook });
    } catch (error) { return next(error); }
  });

  app.get("/api/drafts/:draftId", async (req, res, next) => {
    try {
      const draft = await database.getDraft(parseOrThrow(idSchema, req.params.draftId), parseOrThrow(tutorIdSchema, req.query.tutorId));
      if (!draft) return res.status(404).json({ error: "Draft not found" });
      return res.json({ draft });
    } catch (error) { return next(error); }
  });

  app.patch("/api/drafts/:draftId", async (req, res, next) => {
    try {
      const draftId = parseOrThrow(idSchema, req.params.draftId);
      const tutorId = parseOrThrow(tutorIdSchema, req.body.tutorId);
      const patch = parseOrThrow(cardPatchSchema.pick({ strengths: true, weaknesses: true, gaps: true, recommendations: true, nextLessonPlan: true }), req.body);
      const draft = await database.updateDraft(draftId, tutorId, {
        ...(patch.strengths !== undefined && { understood: patch.strengths }),
        ...(patch.weaknesses !== undefined && { difficulties: patch.weaknesses }),
        ...(patch.gaps !== undefined && { gaps: patch.gaps }),
        ...(patch.recommendations !== undefined && { recommendations: patch.recommendations }),
        ...(patch.nextLessonPlan !== undefined && { nextLessonPlan: patch.nextLessonPlan }),
      });
      if (!draft) return res.status(409).json({ error: "Draft not found or already finalized" });
      return res.json({ draft });
    } catch (error) { return next(error); }
  });

  app.post("/api/drafts/:draftId/approve", async (req, res, next) => {
    try {
      const draftId = parseOrThrow(idSchema, req.params.draftId);
      const tutorId = parseOrThrow(tutorIdSchema, req.body.tutorId);
      const draft = await database.approveDraft(draftId, tutorId);
      if (!draft) return res.status(409).json({ error: "Draft not found or already finalized" });
      return res.json({ draft, card: await database.getCard(draft.studentId) });
    } catch (error) { return next(error); }
  });

  app.use((req, res) => res.status(404).json({ error: "Not found", path: req.originalUrl }));
  app.use((error, _req, res, _next) => {
    if (error.code === "AI_NOT_CONFIGURED") return res.status(503).json({ error: error.message, code: error.code });
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error(error);
    return res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

module.exports = { createApp };
