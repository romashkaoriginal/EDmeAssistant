const test = require("node:test");
const assert = require("node:assert/strict");
const { LessonAnalyzer, analysisJsonSchema, parseStructuredOutput } = require("../src/analyzer");

const validAnalysis = {
  lessonTopic: "Дроби",
  subtopics: ["Сложение дробей"],
  covered: ["Общий знаменатель"],
  reinforced: [],
  understood: ["Ученик находит общий знаменатель"],
  difficulties: [],
  gaps: [],
  recommendations: ["Дать домашнее задание"],
  nextLessonPlan: "Закрепить сложение дробей.",
  lessonDate: null,
};

test("analysis JSON Schema forbids undocumented fields", () => {
  assert.equal(analysisJsonSchema.strict, true);
  assert.equal(analysisJsonSchema.schema.additionalProperties, false);
  assert.deepEqual(analysisJsonSchema.schema.required, Object.keys(validAnalysis));
});

test("structured analysis is accepted without Markdown cleanup", () => {
  assert.deepEqual(parseStructuredOutput(JSON.stringify(validAnalysis)), validAnalysis);
});

test("structured analysis rejects Markdown wrapped output", () => {
  assert.throws(() => parseStructuredOutput(`\`\`\`json\n${JSON.stringify(validAnalysis)}\n\`\`\``));
});

test("OpenRouter receives a strict JSON Schema request", async () => {
  const analyzer = new LessonAnalyzer({ apiKey: "test-key", provider: "openrouter", model: "qwen/qwen3-32b" });
  let request;
  analyzer.client = {
    chat: {
      completions: {
        create: async (payload) => {
          request = payload;
          return { choices: [{ message: { content: JSON.stringify(validAnalysis) } }] };
        },
      },
    },
  };

  await analyzer.analyze({
    student: { full_name: "Иван Иванов", subject: "Математика", grade: "6" },
    transcript: { lessonDate: "2026-07-11", text: "Ученик разобрал сложение дробей с общим знаменателем." },
  });

  assert.equal(request.response_format.type, "json_schema");
  assert.equal(request.response_format.json_schema.strict, true);
  assert.equal(request.response_format.json_schema.schema.additionalProperties, false);
});

test("analysis metadata contains token use and Qwen cost", () => {
  const analyzer = new LessonAnalyzer({ apiKey: "test-key", provider: "openrouter", model: "qwen/qwen3-32b" });
  assert.deepEqual(analyzer.getMetadata({
    usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
    durationMs: 100,
  }), {
    provider: "openrouter",
    model: "qwen/qwen3-32b",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    totalTokens: 2_000_000,
    estimatedCostUsd: 0.36,
    durationMs: 100,
    rawResponse: null,
  });
});
