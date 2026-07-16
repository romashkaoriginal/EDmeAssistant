const test = require("node:test");
const assert = require("node:assert/strict");
const { runLessonAnalysis, runProfileAnalysis, profileBatches, transcriptParts } = require("../src/analysis-runner");

const transcript = { id: 10, studentId: 20 };
const student = { id: 20 };

test("successful analysis saves a usage log before the draft", async () => {
  const calls = [];
  const database = {
    createAiAnalysisLog: async (log) => calls.push(["log", log]),
    saveAnalysis: async (...args) => { calls.push(["draft", args]); return { id: 30 }; },
  };
  const analyzer = {
    analyze: async () => ({ analysis: { lessonTopic: "Дроби" }, metadata: { provider: "openrouter", model: "qwen/qwen3-32b" } }),
  };

  const draft = await runLessonAnalysis({ analyzer, database, transcript, student, tutorId: 1 });

  assert.equal(draft.id, 30);
  assert.equal(calls[0][0], "log");
  assert.equal(calls[0][1].status, "succeeded");
  assert.equal(calls[1][0], "draft");
});

test("failed analysis saves error details and rethrows the original error", async () => {
  const failure = Object.assign(new Error("Provider timeout"), {
    aiMetadata: { provider: "openrouter", model: "qwen/qwen3-32b", durationMs: 5000 },
  });
  let log;
  const database = { createAiAnalysisLog: async (value) => { log = value; } };
  const analyzer = { analyze: async () => { throw failure; }, getMetadata: () => ({}) };

  await assert.rejects(
    runLessonAnalysis({ analyzer, database, transcript, student, tutorId: 1 }),
    /Provider timeout/,
  );
  assert.equal(log.status, "failed");
  assert.equal(log.errorMessage, "Provider timeout");
  assert.equal(log.durationMs, 5000);
});

test("deep profile analysis processes transcript batches chronologically and creates one draft", async () => {
  const calls = [];
  const analyzer = {
    analyzeProfile: async ({ card, transcripts }) => {
      calls.push({ card, transcriptIds: transcripts.map((item) => item.id) });
      return {
        profile: {
          currentLevel: "Средний",
          topics: transcripts.map((item) => `Тема ${item.id}`),
          strengths: [], weaknesses: [], gaps: [], recommendations: [],
          learningGoal: "", learningPace: "", features: "", nextLessonPlan: "",
          missingFields: ["learningGoal"],
        },
        metadata: { provider: "test", model: "test" },
      };
    },
  };
  let savedDraft;
  const database = {
    createAiAnalysisLog: async (value) => calls.push({ log: value.status }),
    createProfileDraft: async (value) => { savedDraft = value; return { id: 9, ...value }; },
  };
  const transcripts = Array.from({ length: 7 }, (_, index) => ({ id: index + 1, lessonDate: `2026-07-0${index + 1}`, text: "Короткая расшифровка" }));

  const draft = await runProfileAnalysis({ analyzer, database, transcripts, student: { id: 4 }, card: {}, tutorId: 2 });

  assert.equal(calls.filter((item) => item.transcriptIds).length, 2);
  assert.deepEqual(calls.filter((item) => item.transcriptIds).map((item) => item.transcriptIds), [[1, 2, 3, 4, 5, 6], [7]]);
  assert.equal(draft.id, 9);
  assert.deepEqual(savedDraft.sourceTranscriptIds, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(savedDraft.missingFields, ["learningGoal"]);
});

test("deep profile batching splits a very long transcript before calling the model", () => {
  const parts = transcriptParts([{ id: 1, text: "x".repeat(40_000) }]);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((item) => item.text.length <= 18_000));
  assert.ok(profileBatches([{ id: 1, text: "x".repeat(100_000) }]).length >= 3);
});
