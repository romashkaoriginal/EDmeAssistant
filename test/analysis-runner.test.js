const test = require("node:test");
const assert = require("node:assert/strict");
const { runLessonAnalysis } = require("../src/analysis-runner");

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
