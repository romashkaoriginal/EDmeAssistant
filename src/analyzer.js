const OpenAI = require("openai");
const { z } = require("zod");
const { toMoscowDateString } = require("./time");

const MODEL_PRICING_USD_PER_MILLION_TOKENS = {
  "qwen/qwen3-32b": { input: 0.08, output: 0.28 },
  "google/gemini-2.5-flash": { input: 0.30, output: 2.50 },
};

const stringArray = z.array(z.string());
const PROFILE_CARD_FIELDS = [
  "currentLevel", "topics", "strengths", "weaknesses", "gaps", "recommendations",
  "learningGoal", "learningPace", "features", "nextLessonPlan",
];
const profileStringArray = z.array(z.string().max(100)).max(3);
const profileTopicsArray = z.array(z.string().max(160)).max(30);
const analysisSchema = z.object({
  lessonTopic: z.string().min(1),
  subtopics: stringArray,
  covered: stringArray,
  reinforced: stringArray,
  understood: stringArray,
  difficulties: stringArray,
  gaps: stringArray,
  recommendations: stringArray,
  nextLessonPlan: z.string(),
  lessonDate: z.string().nullable(),
});

const analysisJsonSchema = {
  name: "lesson_analysis",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      lessonTopic: { type: "string", description: "Главная тема урока." },
      subtopics: { type: "array", items: { type: "string" }, description: "Подтемы урока." },
      covered: { type: "array", items: { type: "string" }, description: "Изученные темы и навыки." },
      reinforced: { type: "array", items: { type: "string" }, description: "Что закрепляли на уроке." },
      understood: { type: "array", items: { type: "string" }, description: "Что ученик понял по фактам из расшифровки." },
      difficulties: { type: "array", items: { type: "string" }, description: "Затруднения ученика." },
      gaps: { type: "array", items: { type: "string" }, description: "Пробелы в знаниях." },
      recommendations: { type: "array", items: { type: "string" }, description: "Рекомендации репетитору." },
      nextLessonPlan: { type: "string", description: "Краткий план следующего урока." },
      lessonDate: { type: ["string", "null"], description: "Дата урока в формате YYYY-MM-DD или null." },
    },
    required: [
      "lessonTopic", "subtopics", "covered", "reinforced", "understood", "difficulties",
      "gaps", "recommendations", "nextLessonPlan", "lessonDate",
    ],
  },
};

const profileAnalysisSchema = z.object({
  currentLevel: z.string().max(150),
  topics: profileTopicsArray,
  strengths: profileStringArray,
  weaknesses: profileStringArray,
  gaps: profileStringArray,
  recommendations: profileStringArray,
  learningGoal: z.string().max(250),
  learningPace: z.string().max(150),
  features: z.string().max(250),
  nextLessonPlan: z.string().max(300),
  missingFields: z.array(z.enum(PROFILE_CARD_FIELDS)),
});

const profileAnalysisJsonSchema = {
  name: "student_profile_analysis",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      currentLevel: { type: "string", maxLength: 150, description: "Текущий уровень ученика, подтверждённый наблюдениями из уроков." },
      topics: { type: "array", maxItems: 30, items: { type: "string", maxLength: 160 }, description: "Изученные темы без повторов, сначала более новые. Сохраняй все подтверждённые темы из уроков, не обрезай формулировки." },
      strengths: { type: "array", maxItems: 3, items: { type: "string", maxLength: 100 }, description: "Подтверждённые сильные стороны." },
      weaknesses: { type: "array", maxItems: 3, items: { type: "string", maxLength: 100 }, description: "Подтверждённые слабые стороны и трудности." },
      gaps: { type: "array", maxItems: 3, items: { type: "string", maxLength: 100 }, description: "Подтверждённые пробелы в знаниях." },
      recommendations: { type: "array", maxItems: 3, items: { type: "string", maxLength: 100 }, description: "Практические рекомендации репетитору." },
      learningGoal: { type: "string", maxLength: 250, description: "Цель обучения, только если она явно следует из данных." },
      learningPace: { type: "string", maxLength: 150, description: "Темп обучения, только если он подтверждён данными нескольких уроков." },
      features: { type: "string", maxLength: 250, description: "Особенности ученика, полезные для проведения занятий." },
      nextLessonPlan: { type: "string", maxLength: 300, description: "Краткий план следующего урока на основе последних данных." },
      missingFields: {
        type: "array",
        items: { type: "string", enum: PROFILE_CARD_FIELDS },
        description: "Поля, которые остались пустыми из-за недостатка фактов.",
      },
    },
    required: [...PROFILE_CARD_FIELDS, "missingFields"],
  },
};

const instructions = [
  "Ты методист для репетиторов.",
  "Анализируй только факты из расшифровки урока.",
  "Не придумывай факты, оценки знаний или рекомендации, которых нельзя обосновать текстом.",
  "Если данных для поля нет, верни пустой массив, пустую строку или null для lessonDate.",
  "Ответ должен строго соответствовать заданной JSON Schema.",
].join(" ");

const profileInstructions = [
  "Ты методист, который собирает доказательную карточку ученика по нескольким урокам.",
  "Используй текущую карточку как накопленный результат предыдущих пакетов и дополняй её новыми фактами.",
  "Не удаляй уже заполненное значение без более свежего явного основания и не выдумывай сведения ради заполнения поля.",
  "Различай слабую сторону и пробел: слабая сторона — наблюдаемая трудность, пробел — конкретное отсутствующее знание или навык.",
  "Цель обучения не выводи только из списка решаемых тем. Темп обучения указывай лишь при достаточных наблюдениях.",
  "Рекомендации и план должны следовать из обнаруженных трудностей, пробелов и последних тем.",
  "Объединяй дубли, учитывай более новые уроки и формулируй каждый пункт кратко.",
  "В missingFields перечисли каждое поле карточки, которое осталось пустым. Пустой список или пустая строка считаются пустым полем.",
  "Ответ должен строго соответствовать заданной JSON Schema.",
].join(" ");

function parseStructuredOutput(output) {
  if (typeof output !== "string" || !output.trim()) {
    throw new Error("AI returned an empty structured response");
  }
  return analysisSchema.parse(JSON.parse(output));
}

function parseProfileStructuredOutput(output) {
  if (typeof output !== "string" || !output.trim()) {
    throw new Error("AI returned an empty profile response");
  }
  return profileAnalysisSchema.parse(JSON.parse(output));
}

class LessonAnalyzer {
  constructor({ apiKey, model, provider = "openai" }) {
    this.provider = provider;
    this.client = apiKey ? new OpenAI({ apiKey, ...(provider === "openrouter" && { baseURL: "https://openrouter.ai/api/v1" }) }) : null;
    this.model = model || (provider === "openrouter" ? "qwen/qwen3-32b" : "gpt-5-mini");
  }

  isConfigured() { return Boolean(this.client); }

  getMetadata({ usage, rawResponse = null, durationMs = null } = {}) {
    const inputTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? null;
    const outputTokens = usage?.completion_tokens ?? usage?.output_tokens ?? null;
    const totalTokens = usage?.total_tokens ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
    const pricing = MODEL_PRICING_USD_PER_MILLION_TOKENS[this.model];
    const estimatedCostUsd = pricing && inputTokens !== null && outputTokens !== null
      ? ((inputTokens * pricing.input) + (outputTokens * pricing.output)) / 1_000_000
      : null;
    return { provider: this.provider, model: this.model, inputTokens, outputTokens, totalTokens, estimatedCostUsd, durationMs, rawResponse };
  }

  async analyze({ transcript, student }) {
    if (!this.client) {
      const error = new Error("AI provider is not configured");
      error.code = "AI_NOT_CONFIGURED";
      throw error;
    }

    const lessonDate = transcript.lessonDate instanceof Date
      ? toMoscowDateString(transcript.lessonDate)
      : String(transcript.lessonDate).slice(0, 10);

    const input = [
      `Ученик: ${student.full_name}.`,
      `Предмет: ${student.subject}.`,
      `Класс: ${student.grade}.`,
      `Дата урока: ${lessonDate}.`,
      "Расшифровка урока:",
      transcript.text,
    ].join("\n");

    const startedAt = Date.now();
    let output = null;
    let usage = null;
    try {
      if (this.provider === "openrouter") {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: [{ role: "system", content: instructions }, { role: "user", content: input }],
          response_format: { type: "json_schema", json_schema: analysisJsonSchema },
        });
        output = response.choices[0]?.message?.content;
        usage = response.usage;
      } else {
        const response = await this.client.responses.create({
          model: this.model,
          store: false,
          instructions,
          input,
          text: { format: { type: "json_schema", ...analysisJsonSchema } },
        });
        output = response.output_text;
        usage = response.usage;
      }
      const result = parseStructuredOutput(output);
      return {
        analysis: { ...result, lessonDate: result.lessonDate || lessonDate },
        metadata: this.getMetadata({ usage, rawResponse: output, durationMs: Date.now() - startedAt }),
      };
    } catch (error) {
      error.aiMetadata = this.getMetadata({ usage, rawResponse: output, durationMs: Date.now() - startedAt });
      throw error;
    }
  }


  async analyzeProfile({ student, card, transcripts }) {
    if (!this.client) {
      const error = new Error("AI provider is not configured");
      error.code = "AI_NOT_CONFIGURED";
      throw error;
    }

    const currentCard = Object.fromEntries(PROFILE_CARD_FIELDS.map((field) => [field, card?.[field] ?? (field === "topics" || ["strengths", "weaknesses", "gaps", "recommendations"].includes(field) ? [] : "")]));
    const transcriptText = transcripts.map((transcript, index) => {
      const lessonDate = transcript.lessonDate instanceof Date
        ? toMoscowDateString(transcript.lessonDate)
        : String(transcript.lessonDate || "").slice(0, 10);
      return [`Урок ${index + 1}. Дата: ${lessonDate || "не указана"}.`, transcript.text].join("\n");
    }).join("\n\n");
    const input = [
      `Ученик: ${student.full_name}.`,
      `Предмет: ${student.subject}.`,
      `Класс: ${student.grade}.`,
      "Текущая накопленная карточка:",
      JSON.stringify(currentCard),
      "Новый пакет расшифровок в хронологическом порядке:",
      transcriptText,
    ].join("\n");

    const startedAt = Date.now();
    let output = null;
    let usage = null;
    try {
      if (this.provider === "openrouter") {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: [{ role: "system", content: profileInstructions }, { role: "user", content: input }],
          response_format: { type: "json_schema", json_schema: profileAnalysisJsonSchema },
        });
        output = response.choices[0]?.message?.content;
        usage = response.usage;
      } else {
        const response = await this.client.responses.create({
          model: this.model,
          store: false,
          instructions: profileInstructions,
          input,
          text: { format: { type: "json_schema", ...profileAnalysisJsonSchema } },
        });
        output = response.output_text;
        usage = response.usage;
      }
      return {
        profile: parseProfileStructuredOutput(output),
        metadata: this.getMetadata({ usage, rawResponse: output, durationMs: Date.now() - startedAt }),
      };
    } catch (error) {
      error.aiMetadata = this.getMetadata({ usage, rawResponse: output, durationMs: Date.now() - startedAt });
      throw error;
    }
  }
}

module.exports = {
  LessonAnalyzer,
  PROFILE_CARD_FIELDS,
  analysisJsonSchema,
  profileAnalysisJsonSchema,
  parseStructuredOutput,
  parseProfileStructuredOutput,
};
