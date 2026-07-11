const OpenAI = require("openai");
const { z } = require("zod");

const MODEL_PRICING_USD_PER_MILLION_TOKENS = {
  "qwen/qwen3-32b": { input: 0.08, output: 0.28 },
  "google/gemini-2.5-flash": { input: 0.30, output: 2.50 },
};

const stringArray = z.array(z.string());
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

const instructions = [
  "Ты методист для репетиторов.",
  "Анализируй только факты из расшифровки урока.",
  "Не придумывай факты, оценки знаний или рекомендации, которых нельзя обосновать текстом.",
  "Если данных для поля нет, верни пустой массив, пустую строку или null для lessonDate.",
  "Ответ должен строго соответствовать заданной JSON Schema.",
].join(" ");

function parseStructuredOutput(output) {
  if (typeof output !== "string" || !output.trim()) {
    throw new Error("AI returned an empty structured response");
  }
  return analysisSchema.parse(JSON.parse(output));
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

    const input = [
      `Ученик: ${student.full_name}.`,
      `Предмет: ${student.subject}.`,
      `Класс: ${student.grade}.`,
      `Дата урока: ${transcript.lessonDate}.`,
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
        analysis: { ...result, lessonDate: result.lessonDate || transcript.lessonDate },
        metadata: this.getMetadata({ usage, rawResponse: output, durationMs: Date.now() - startedAt }),
      };
    } catch (error) {
      error.aiMetadata = this.getMetadata({ usage, rawResponse: output, durationMs: Date.now() - startedAt });
      throw error;
    }
  }
}

module.exports = { LessonAnalyzer, analysisJsonSchema, parseStructuredOutput };
