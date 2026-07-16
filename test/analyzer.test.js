const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LessonAnalyzer,
  PROFILE_CARD_FIELDS,
  analysisJsonSchema,
  profileAnalysisJsonSchema,
  parseStructuredOutput,
  parseProfileStructuredOutput,
} = require("../src/analyzer");

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

const validProfile = {
  currentLevel: "Средний",
  topics: ["Дроби", "Уравнения"],
  strengths: ["Быстро выполняет вычисления"],
  weaknesses: ["Ошибается со знаками"],
  gaps: ["Неустойчиво приводит дроби к общему знаменателю"],
  recommendations: ["Закрепить общий знаменатель"],
  learningGoal: "Подготовиться к контрольной",
  learningPace: "Средний",
  features: "Лучше усваивает материал на примерах",
  nextLessonPlan: "Повторить сложение дробей и решить задачи.",
  missingFields: [],
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

test("deep profile schema covers every student card field and stays strict", () => {
  assert.equal(profileAnalysisJsonSchema.strict, true);
  assert.equal(profileAnalysisJsonSchema.schema.additionalProperties, false);
  assert.deepEqual(profileAnalysisJsonSchema.schema.required, [...PROFILE_CARD_FIELDS, "missingFields"]);
  assert.deepEqual(parseProfileStructuredOutput(JSON.stringify(validProfile)), validProfile);
});

test("deep profile keeps enough studied topics for a full card", () => {
  const topics = Array.from({ length: 30 }, (_, index) => `Тема ${index + 1}`);
  const parsed = parseProfileStructuredOutput(JSON.stringify({ ...validProfile, topics }));
  assert.equal(profileAnalysisJsonSchema.schema.properties.topics.maxItems, 30);
  assert.equal(profileAnalysisJsonSchema.schema.properties.topics.items.maxLength, 160);
  assert.deepEqual(parsed.topics, topics);
});

test("deep profile analysis sends the accumulated card and a transcript batch", async () => {
  const analyzer = new LessonAnalyzer({ apiKey: "test-key", provider: "openrouter", model: "qwen/qwen3-32b" });
  let request;
  analyzer.client = {
    chat: {
      completions: {
        create: async (payload) => {
          request = payload;
          return { choices: [{ message: { content: JSON.stringify(validProfile) } }], usage: {} };
        },
      },
    },
  };

  const result = await analyzer.analyzeProfile({
    student: { full_name: "Иван Иванов", subject: "Математика", grade: 7 },
    card: { currentLevel: "Начальный", strengths: [], topics: ["Проценты"] },
    transcripts: [{ lessonDate: "2026-07-01", text: "Разобрали дроби. Ученик ошибался со знаками." }],
  });

  assert.deepEqual(result.profile, validProfile);
  assert.equal(request.response_format.json_schema.name, "student_profile_analysis");
  assert.match(request.messages[1].content, /Начальный/);
  assert.match(request.messages[1].content, /Разобрали дроби/);
});
