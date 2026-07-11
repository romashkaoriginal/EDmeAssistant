const OpenAI = require("openai");
const { z } = require("zod");

const analysisSchema = z.object({
  lessonTopic: z.string().min(1), subtopics: z.array(z.string()).default([]), covered: z.array(z.string()).default([]),
  reinforced: z.array(z.string()).default([]), understood: z.array(z.string()).default([]),
  difficulties: z.array(z.string()).default([]), gaps: z.array(z.string()).default([]),
  recommendations: z.array(z.string()).default([]), nextLessonPlan: z.string().default(""), lessonDate: z.string().optional(),
});

function parseModelJson(output) {
  return JSON.parse(output.trim().replace(/^```json\s*/i, "").replace(/\s*```$/, ""));
}

class LessonAnalyzer {
  constructor({ apiKey, model, provider = "openai" }) {
    this.provider = provider;
    this.client = apiKey ? new OpenAI({ apiKey, ...(provider === "openrouter" && { baseURL: "https://openrouter.ai/api/v1" }) }) : null;
    this.model = model || (provider === "openrouter" ? "openrouter/free" : "gpt-5-mini");
  }
  isConfigured() { return Boolean(this.client); }
  async analyze({ transcript, student }) {
    if (!this.client) { const error = new Error("OPENAI_API_KEY is not configured"); error.code = "AI_NOT_CONFIGURED"; throw error; }
    const instructions = "Ты методист для репетиторов. Проанализируй только факты из краткой расшифровки. Не выдумывай факты. Верни ТОЛЬКО валидный JSON без Markdown с ключами lessonTopic, subtopics, covered, reinforced, understood, difficulties, gaps, recommendations, nextLessonPlan, lessonDate. Все значения кроме lessonTopic, nextLessonPlan и lessonDate - массивы строк.";
    const input = `Ученик: ${student.full_name}; предмет: ${student.subject}; класс: ${student.grade}. Дата урока: ${transcript.lessonDate}.\nКраткая расшифровка:\n${transcript.text}`;
    const output = this.provider === "openrouter"
      ? (await this.client.chat.completions.create({ model: this.model, messages: [{ role: "system", content: instructions }, { role: "user", content: input }] })).choices[0]?.message?.content
      : (await this.client.responses.create({ model: this.model, store: false, instructions, input })).output_text;
    const result = analysisSchema.parse(parseModelJson(output || ""));
    return { ...result, lessonDate: result.lessonDate || transcript.lessonDate };
  }
}

module.exports = { LessonAnalyzer };
