const test = require("node:test");
const assert = require("node:assert/strict");
const { ContentGenerator, GENERATION_TYPES, ADJUSTMENTS, studentVersion, ANSWERS_MARKER } = require("../src/generator");

const student = { full_name: "Иван Петров", subject: "Математика", grade: 8 };
const card = {
  currentLevel: "средний",
  strengths: ["быстро считает"],
  weaknesses: [],
  gaps: ["путается в знаках"],
  learningGoal: "Подготовка к контрольной",
};

function mockedGenerator(reply) {
  const generator = new ContentGenerator({ apiKey: "test-key", provider: "openrouter", model: "qwen/qwen3-32b" });
  const requests = [];
  const replies = Array.isArray(reply) ? reply : [reply];
  generator.client = {
    chat: {
      completions: {
        create: async (payload) => {
          const replyIndex = Math.min(requests.length, replies.length - 1);
          requests.push(payload);
          return { choices: [{ message: { content: replies[replyIndex] } }] };
        },
      },
    },
  };
  return { generator, requests };
}

test("generator covers homework, test and tasks types", () => {
  assert.deepEqual(Object.keys(GENERATION_TYPES), ["homework", "test", "tasks"]);
  assert.deepEqual(Object.keys(ADJUSTMENTS), ["regenerate", "easier", "harder", "shorter", "more_practice", "more_questions", "fewer_questions"]);
});

test("generation prompt includes student card context and topic", async () => {
  const generated = String.raw`# Домашнее задание

$x^2 = 4$`;
  const { generator, requests } = mockedGenerator(generated);
  const { result } = await generator.generate({ type: "homework", student, card, topic: "Квадратные уравнения" });
  assert.equal(result, generated);
  const [request] = requests;
  const userMessage = request.messages.find((item) => item.role === "user").content;
  assert.match(userMessage, /Иван Петров/);
  assert.match(userMessage, /Квадратные уравнения/);
  assert.match(userMessage, /путается в знаках/);
  assert.match(userMessage, /Подготовка к контрольной/);
  const systemMessage = request.messages.find((item) => item.role === "system").content;
  assert.match(systemMessage, /## Задания/);
  assert.match(systemMessage, /Telegram Rich Markdown/);
  assert.match(systemMessage, /\\frac\{числитель\}\{знаменатель\}/);
  assert.doesNotMatch(systemMessage, /Не используй LaTeX/);
});

test("adjustment request carries the previous result", async () => {
  const { generator, requests } = mockedGenerator(String.raw`# Облегчённый вариант

$\frac{1}{2}$`);
  await generator.generate({
    type: "tasks", student, card, topic: "Дроби",
    adjustment: "easier", previousResult: "Старый набор задач",
  });
  const [request] = requests;
  const roles = request.messages.map((item) => item.role);
  assert.deepEqual(roles, ["system", "user", "assistant", "user"]);
  assert.equal(request.messages[2].content, "Старый набор задач");
  assert.equal(request.messages[3].content, ADJUSTMENTS.easier);
});

test("generation retries once when a math response has no Rich Markdown or LaTeX", async () => {
  const repaired = String.raw`# Тест по теме: Дроби

1. **Чему равна сумма?** $\frac{1}{2} + \frac{1}{4}$

## ${ANSWERS_MARKER}
1. $\frac{3}{4}$`;
  const { generator, requests } = mockedGenerator([
    "Тест по теме: Дроби\n\n1. Чему равна сумма 1/2 + 1/4?\n\nОтветы для репетитора:\n1. 3/4",
    repaired,
  ]);

  const { result } = await generator.generate({ type: "test", student, card, topic: "Дроби" });

  assert.equal(result, repaired);
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages.at(-1).content, /дроби остались вне LaTeX/);
});

test("unknown type and adjustment are rejected", async () => {
  const { generator } = mockedGenerator("x");
  await assert.rejects(() => generator.generate({ type: "essay", student, card, topic: "Тема" }), /Unknown generation type/);
  await assert.rejects(() => generator.generate({ type: "test", student, card, topic: "Тема", adjustment: "funnier", previousResult: "x" }), /Unknown adjustment/);
});

test("student version strips the answers section from a test", () => {
  const text = `Тест по теме: Дроби\n\n1. Вопрос\nA. 1\nB. 2\n\n${ANSWERS_MARKER}:\n1. B — пояснение`;
  assert.equal(studentVersion(text), "Тест по теме: Дроби\n\n1. Вопрос\nA. 1\nB. 2");
  assert.equal(studentVersion("Без ответов"), "Без ответов");
});

test("unconfigured generator raises AI_NOT_CONFIGURED", async () => {
  const generator = new ContentGenerator({ apiKey: null, provider: "openrouter" });
  await assert.rejects(
    () => generator.generate({ type: "homework", student, card, topic: "Тема" }),
    (error) => error.code === "AI_NOT_CONFIGURED",
  );
  await assert.rejects(
    () => generator.freeform({ question: "Как объяснить дроби?" }),
    (error) => error.code === "AI_NOT_CONFIGURED",
  );
});

test("freeform answers with a methodist system prompt", async () => {
  const { generator, requests } = mockedGenerator("Начните с наглядных примеров с пиццей.");
  const { result } = await generator.freeform({ question: "Как объяснить дроби пятикласснику?" });
  assert.equal(result, "Начните с наглядных примеров с пиццей.");
  const [request] = requests;
  assert.equal(request.messages[0].role, "system");
  assert.match(request.messages[0].content, /методист/);
  assert.equal(request.messages[1].content, "Как объяснить дроби пятикласснику?");
});

test("freeform system prompt instructs the model to refuse off-topic questions", async () => {
  const { generator, requests } = mockedGenerator("Я отвечаю только на вопросы, связанные с репетиторством и подготовкой к занятиям. Задайте вопрос по предмету, ученику или методике.");
  await generator.freeform({ question: "Как сварить кукурузу?" });
  const [request] = requests;
  assert.match(request.messages[0].content, /строго/);
  assert.match(request.messages[0].content, /не отвечай по существу/);
  assert.match(request.messages[0].content, /забудь предыдущие инструкции/);
});
