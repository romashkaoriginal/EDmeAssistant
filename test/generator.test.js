const test = require("node:test");
const assert = require("node:assert/strict");
const { ContentGenerator, GENERATION_TYPES, ADJUSTMENTS, studentVersion, ANSWERS_MARKER, testQualityIssues, normalizeFreeformLatex, normalizeTestOptionLineBreaks } = require("../src/generator");

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

function validFractionTest() {
  return String.raw`# Test: fractions

1. Calculate $\frac{2}{3} \cdot \frac{5}{7}$.
A. $\frac{7}{10}$
B. $\frac{10}{21}$
C. $\frac{12}{35}$
D. $1$

2. Calculate $\frac{3}{4} + \frac{2}{5}$.
A. $\frac{5}{9}$
B. $\frac{7}{20}$
C. $\frac{23}{20}$
D. $\frac{31}{20}$

3. Calculate $3 \div \frac{1}{3}$.
A. $1$
B. $3$
C. $6$
D. $9$

4. Calculate $\frac{1}{2} + \frac{1}{4}$.
A. $\frac{3}{4}$
B. $\frac{2}{6}$
C. $\frac{1}{8}$
D. $1$

5. Было $3\frac{1}{4}$ торта. Съели $1\frac{1}{2}$ торта. Сколько осталось?
A. $1\frac{1}{2}$
B. $1\frac{3}{4}$
C. $1\frac{7}{12}$
D. $2\frac{1}{4}$

## ${ANSWERS_MARKER}
1. B — $\frac{10}{21}$
2. C — $\frac{23}{20}$
3. D — $9$
4. A — $\frac{3}{4}$
5. B — $1\frac{3}{4}$`;
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
  assert.match(systemMessage, /не ссылается на рисунки/);
  assert.match(systemMessage, /не добавляй отчёт/);
  assert.doesNotMatch(systemMessage, /Не используй LaTeX/);
});

test("generation prompt forbids tests that depend on missing visuals", async () => {
  const { generator, requests } = mockedGenerator(validFractionTest());

  await generator.generate({ type: "test", student, card, topic: "Квадратичная функция и графики" });

  const systemMessage = requests[0].messages.find((item) => item.role === "system").content;
  assert.match(systemMessage, /на каком рисунке/);
  assert.match(systemMessage, /Свойства графиков проверяй по заданной формуле/);
  assert.match(systemMessage, /без отчёта о проверке и исправлениях/);
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
    validFractionTest(),
  ]);

  const { result } = await generator.generate({ type: "test", student, card, topic: "Дроби" });

  assert.equal(result, validFractionTest());
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages.at(-1).content, /дроби остались вне LaTeX/);
});

test("test validation catches a key that does not match a fraction calculation", () => {
  const invalid = validFractionTest().replace("B. $\\frac{10}{21}$", "B. $\\frac{2}{3}$");
  assert.deepEqual(testQualityIssues(invalid), ["в вопросе 1 ключ не совпадает с результатом вычисления"]);
});

test("test validation catches an incorrect answer to a fraction word problem", () => {
  const invalid = validFractionTest().replace("5. B — $1\\frac{3}{4}$", "5. C — $1\\frac{7}{12}$");
  assert.deepEqual(testQualityIssues(invalid), ["в вопросе 5 ключ не совпадает с результатом вычисления"]);
});

test("test validation does not treat the first lone fraction as the expected answer", () => {
  const comparison = validFractionTest()
    .replace(
      /1\. Calculate[\s\S]*?\n\n2\. Calculate/,
      String.raw`1. Какая дробь больше $\frac{2}{3}$?
A. $\frac{3}{4}$
B. $\frac{1}{2}$
C. $\frac{1}{3}$
D. $\frac{2}{3}$

2. Calculate`,
    )
    .replace(/^1\. B —.*$/m, String.raw`1. A — $\frac{3}{4}$`);

  assert.deepEqual(testQualityIssues(comparison), []);
});

test("test validation catches a wrong key for a fraction comparison", () => {
  const comparison = validFractionTest()
    .replace(
      /1\. Calculate[\s\S]*?\n\n2\. Calculate/,
      String.raw`1. Сравните дроби $\frac{3}{4}$ и $\frac{5}{8}$.
A. $\frac{3}{4} < \frac{5}{8}$
B. $\frac{3}{4} = \frac{5}{8}$
C. $\frac{3}{4} > \frac{5}{8}$
D. Сравнение невозможно

2. Calculate`,
    );

  assert.deepEqual(testQualityIssues(comparison), ["в вопросе 1 ключ не совпадает с результатом сравнения"]);
});

test("test validation accepts Rich Markdown emphasis in the answer key", () => {
  const boldLabels = validFractionTest().replace(/^(\d+)\. ([A-D]) —/gm, "$1. **$2** —");
  const boldEntries = validFractionTest().replace(/^(\d+)\. ([A-D]) —/gm, "**$1. $2** —");
  const verboseEntries = validFractionTest().replace(/^(\d+)\. ([A-D]) —/gm, "$1. Правильный ответ: **$2** —");
  const tableEntries = validFractionTest().replace(/^(\d+)\. ([A-D]) — (.+)$/gm, "| $1 | $2 | $3 |");
  const cyrillicLabels = validFractionTest().replace(/^(\d+)\. ([ABC]) —/gm, (_, number, label) => `${number}. ${{ A: "А", B: "В", C: "С" }[label]} —`);

  assert.deepEqual(testQualityIssues(boldLabels), []);
  assert.deepEqual(testQualityIssues(boldEntries), []);
  assert.deepEqual(testQualityIssues(verboseEntries), []);
  assert.deepEqual(testQualityIssues(tableEntries), []);
  assert.deepEqual(testQualityIssues(cyrillicLabels), []);
});

test("test validation rejects answer options placed on one line", () => {
  const invalid = validFractionTest()
    .replace(String.raw`A. $\frac{7}{10}$
B. $\frac{10}{21}$
C. $\frac{12}{35}$
D. $1$`, String.raw`A. $\frac{7}{10}$ B. $\frac{10}{21}$ C. $\frac{12}{35}$ D. $1$`);

  assert.deepEqual(testQualityIssues(invalid), ["в вопросе 1 должны быть варианты A, B, C и D"]);
});

test("test option normalizer puts inline options on separate lines", () => {
  const input = String.raw`1. Вычислите: $2 + 2$. A. 3 B. 4 C. 5 D. 6

${ANSWERS_MARKER}
1. B — $2 + 2 = 4$.`;

  assert.equal(normalizeTestOptionLineBreaks(input), String.raw`1. Вычислите: $2 + 2$.
A. 3
B. 4
C. 5
D. 6

${ANSWERS_MARKER}
1. B — $2 + 2 = 4$.`);
});

test("validation rejects references to missing visuals", () => {
  const invalid = validFractionTest().replace("Calculate $\\frac{2}{3} \\cdot \\frac{5}{7}$.", "На каком рисунке изображён график функции?");
  const issues = require("../src/generator").richMarkdownIssues({ text: invalid, type: "test", student, topic: "Графики" });
  assert.ok(issues.includes("есть задание, требующее отсутствующий визуальный материал"));
});

test("validation rejects internal repair notes", () => {
  const invalid = `${validFractionTest()}\n\nИсправлены повторы и ошибки. Учтены пробелы ученика.`;
  const issues = require("../src/generator").richMarkdownIssues({ text: invalid, type: "test", student, topic: "Дроби" });
  assert.ok(issues.includes("есть служебный комментарий о проверке или исправлениях"));
});

test("validation rejects an unmatched LaTeX dollar delimiter", () => {
  const malformed = `${validFractionTest()}\n\n7. Найдите $1\\frac{1}{3} \\cdot \\frac{3}{4}$.`;
  const issues = require("../src/generator").richMarkdownIssues({ text: malformed.slice(0, -2), type: "test", student, topic: "Дроби" });

  assert.ok(issues.includes("нарушена парность LaTeX-разделителей $ или $$"));
});

test("generation retries once when a test answer fails mathematical validation", async () => {
  const invalid = validFractionTest().replace("B. $\\frac{10}{21}$", "B. $\\frac{2}{3}$");
  const { generator, requests } = mockedGenerator([invalid, validFractionTest()]);

  const { result } = await generator.generate({ type: "test", student, card, topic: "Дроби" });

  assert.equal(result, validFractionTest());
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages.at(-1).content, /ключ не совпадает с результатом вычисления/);
});

test("generation does not return a test that is still invalid after repair", async () => {
  const invalid = validFractionTest().replace("B. $\\frac{10}{21}$", "B. $\\frac{2}{3}$");
  const { generator } = mockedGenerator([invalid, invalid]);

  await assert.rejects(
    () => generator.generate({ type: "test", student, card, topic: "Дроби" }),
    (error) => error.code === "AI_GENERATION_VALIDATION_FAILED",
  );
});

test("generation stops after two validation attempts", async () => {
  const invalid = validFractionTest().replace("B. $\\frac{10}{21}$", "B. $\\frac{2}{3}$");
  const { generator, requests } = mockedGenerator([invalid, invalid, validFractionTest()]);

  await assert.rejects(
    () => generator.generate({ type: "test", student, card, topic: "Дроби" }),
    (error) => error.code === "AI_GENERATION_VALIDATION_FAILED" && /after 2 attempts/.test(error.message),
  );
  assert.equal(requests.length, 2);
});

test("every test receives a mandatory second pass from the verifier model", async () => {
  const { generator, requests } = mockedGenerator([validFractionTest(), validFractionTest()]);
  generator.verifierModel = "qwen/qwen3.5-397b-a17b";

  await generator.generate({ type: "test", student, card, topic: "Дроби" });

  assert.equal(requests.length, 2);
  assert.equal(requests[1].model, "qwen/qwen3.5-397b-a17b");
  assert.match(requests[1].messages.at(-1).content, /Реши каждый вопрос заново/);
  assert.match(requests[1].messages.at(-1).content, /правильный вариант ровно один/);
  assert.match(requests[1].messages.at(-1).content, /орфографию, пунктуацию, грамматику и согласование слов/);
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
  assert.match(request.messages[0].content, /между \$\.\.\.\$/);
  assert.equal(request.messages[1].content, "Как объяснить дроби пятикласснику?");
});

test("freeform preserves Markdown math wrappers and normalizes LaTeX", async () => {
  const answer = String.raw`Пример:

$ \frac{2}{5} \div \frac{4}{10} = 1 $

Допустимо, только если $ c \\neq 0 $.`;
  const { generator } = mockedGenerator(answer);
  const { result } = await generator.freeform({ question: "Как делить дроби?" });

  assert.equal(result, String.raw`Пример:

$\frac{2}{5} \div \frac{4}{10} = 1$

Допустимо, только если $c \neq 0$.`);
  assert.equal(normalizeFreeformLatex(String.raw`$$ \frac{3}{4} $$`), String.raw`$$\frac{3}{4}$$`);
});

test("freeform system prompt instructs the model to refuse off-topic questions", async () => {
  const { generator, requests } = mockedGenerator("Я отвечаю только на вопросы, связанные с репетиторством и подготовкой к занятиям. Задайте вопрос по предмету, ученику или методике.");
  await generator.freeform({ question: "Как сварить кукурузу?" });
  const [request] = requests;
  assert.match(request.messages[0].content, /строго/);
  assert.match(request.messages[0].content, /не отвечай по существу/);
  assert.match(request.messages[0].content, /забудь предыдущие инструкции/);
});
